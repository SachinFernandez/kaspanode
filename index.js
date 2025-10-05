const express = require("express");
const axios = require("axios");
globalThis.WebSocket = require("websocket").w3cwebsocket;

const kaspa = require("kaspa-wasm");
const bodyParser = require("body-parser");
const app = express();
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

const KASPA_REST = "https://api.kaspa.org"; // Public REST API


function getAddressFromPrivateKey(privateKeyHex) {
  try {
    const keyPair = kaspa.KeyPair.fromPrivateKey(privateKeyHex);
    return keyPair.getAddress(); 
  } catch (err) {
    return null;
  }
}

// ===== Health Check =====
app.get("/health", async (req, res) => {
  try {
    const resp = await axios.get(`${KASPA_REST}/info/health`);
    res.json({
      status: "OK",
      kaspaRestData: resp.data
    });
  } catch (err) {
    console.error("Health check failed:", err.response?.data || err.message);
    res.status(500).json({
      status: "ERROR",
      error: err.response?.data || err.message
    });
  }
});

// ===== Balance Check =====
app.get("/balance/:address", async (req, res) => {
  const { address } = req.params;
  try {
    const resp = await axios.get(`${KASPA_REST}/addresses/${address}/balance`);
    res.json({
      status: "OK",
      balance: resp.data
    });
  } catch (err) {
    console.error("Balance check failed:", err.response?.data || err.message);
    res.status(500).json({
      status: "ERROR",
      error: err.response?.data || err.message
    });
  }
});

// ===== UTXOs =====
app.get("/utxos/:address", async (req, res) => {
  const { address } = req.params;
  try {
    const resp = await axios.get(`${KASPA_REST}/addresses/${address}/utxos`);
    res.json({
      status: "OK",
      utxos: resp.data
    });
  } catch (err) {
    console.error("UTXO fetch failed:", err.response?.data || err.message);
    res.status(500).json({
      status: "ERROR",
      error: err.response?.data || err.message
    });
  }
});

app.post('/createTransaction', async (req, res) => {
  try {
    const { senderAddress, recipientAddress, amount, fee, privateKey } = req.body;

    // 1. Validate required params
    if (!senderAddress || !recipientAddress || amount === undefined || fee === undefined || !privateKey) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // 2. Validate address format
    const kaspaRegex = /^kaspa:[a-z0-9]{61,63}$/;
    if (!kaspaRegex.test(senderAddress)) {
      return res.status(400).json({ error: "Invalid sender address format" });
    }
    if (!kaspaRegex.test(recipientAddress)) {
      return res.status(400).json({ error: "Invalid recipient address format" });
    }

    // 3. Validate private key → sender address
    // const derivedAddress = getAddressFromPrivateKey(privateKey);
    // if (!derivedAddress) {
    //   return res.status(400).json({ error: "Invalid private key" });
    // }
    // if (derivedAddress !== senderAddress) {
    //   return res.status(400).json({ error: "Private key does not match sender address" });
    // }

    // 4. Validate recipient ≠ sender
    if (recipientAddress === senderAddress) {
      return res.status(400).json({ error: "Recipient address cannot equal sender address" });
    }

    // 5. Validate amount/fee
    if (amount <= 0) {
      return res.status(400).json({ error: "Transfer amount must be greater than 0" });
    }
    if (fee < 0) {
      return res.status(400).json({ error: "Fee cannot be negative" });
    }
	
    // 6. Fetch UTXOs for sender
    let utxosResp;
    try {
      utxosResp = await axios.get(`${KASPA_REST}/addresses/${senderAddress}/utxos`);
    } catch (err) {
      return res.status(400).json({ error: "Invalid sender address or unable to fetch UTXOs" });
    }
    
    const utxos = utxosResp.data.utxos || utxosResp.data; // adjust based on actual response structure
    if (!utxos || utxos.length === 0) { return res.status(400).json({ error: 'No UTXOs available for the sender address' }); }

    // 7. Map UTXOs to inputs
    const inputs = utxos.map(utxo => ({
      transactionId: utxo.outpoint.transactionId,
      outputIndex: utxo.outpoint.index,
      amount: BigInt(utxo.utxoEntry.amount),
      scriptPublicKey: utxo.utxoEntry.scriptPublicKey.scriptPublicKey
    }));

    const totalInputAmount = inputs.reduce((sum, utxo) => sum + utxo.amount, BigInt(0));
    const amountBigInt = BigInt(Math.floor(amount * 1e8)); 
    const feeBigInt = BigInt(Math.floor(fee * 1e8));
    const changeAmount = totalInputAmount - amountBigInt - feeBigInt;

    // 8. Validate balance
    if (changeAmount < 0n) {
      return res.status(400).json({ error: "Insufficient funds" });
    }
	
    // 9. Fetch balance for sender
    let balanceResp;
    try {
      balanceResp = await axios.get(`${KASPA_REST}/addresses/${senderAddress}/balance`);
    } catch (err) {
      balanceResp = { data: { balance: null } };
    }

    // 10. Build unsigned transaction
    const unsignedTx = {
      inputs,
      outputs: [
        { recipient: recipientAddress, amount: amountBigInt },
        { recipient: senderAddress, amount: changeAmount }
      ]
    };

    // Serialize BigInt as string for safe JSON transmission
    const replacer = (key, value) =>
      typeof value === 'bigint' ? value.toString() : value;


    res.json({
      status: "OK",
      unsignedTx: JSON.parse(JSON.stringify(unsignedTx, replacer)),
      transferredAmount: amountBigInt.toString(),
      chargedAmount: (amountBigInt + feeBigInt).toString(),
      walletBalance: balanceResp.data.balance
    });

  } catch (error) {
    console.error('Error creating transaction:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== Transactions by Address (History) =====
app.get("/transactions/:address", async (req, res) => {
  const { address } = req.params;
  try {
    // This endpoint may differ depending on API version.
    const resp = await axios.get(`${KASPA_REST}/addresses/${address}/transactions`);
    res.json({
      status: "OK",
      transactions: resp.data
    });
  } catch (err) {
    console.error("Transaction fetch failed:", err.response?.data || err.message);
    res.status(500).json({
      status: "ERROR",
      error: err.response?.data || err.message
    });
  }
});

// ===== Submit Transaction =====
app.post("/submit", async (req, res) => {
  try {
    // Expect { tx } in body, as a raw signed transaction string.
    const { tx } = req.body;
    if (!tx) {
      return res.status(400).json({ status: "ERROR", error: "Missing signed transaction data" });
    }
    const resp = await axios.post(`${KASPA_REST}/transactions`, { tx });
    res.json({
      status: "OK",
      result: resp.data
    });
  } catch (err) {
    console.error("Transaction submission failed:", err.response?.data || err.message);
    res.status(500).json({
      status: "ERROR",
      error: err.response?.data || err.message
    });
  }
});

// ===== Transaction History =====
// Use this endpoint if the previous /transactions endpoint does not work
app.get("/history/:address", async (req, res) => {
  const { address } = req.params;
  try {
    // Some APIs may require pagination or other filters
    const resp = await axios.get(`${KASPA_REST}/addresses/${address}/transactions`);
    res.json({
      status: "OK",
      history: resp.data
    });
  } catch (err) {
    console.error("Transaction history fetch failed:", err.response?.data || err.message);
    res.status(500).json({
      status: "ERROR",
      error: err.response?.data || err.message
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Kaspa API listening on port ${PORT}`);
});
