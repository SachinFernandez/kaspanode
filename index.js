const express = require("express");
const axios = require("axios");
globalThis.WebSocket = require("websocket").w3cwebsocket;

const kaspa = require("kaspa-wasm");
const bodyParser = require("body-parser");
const { PrivateKey, Transaction, Script, Address, crypto } = require('@kaspa/core-lib');
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

      // 1. Validate required parameters
      if (
        !senderAddress ||
        !recipientAddress ||
        amount === undefined ||
        fee === undefined ||
        !privateKey
      ) {
        return res.status(400).json({ error: "Missing required parameters" });
      }

      // 2. Validate address format
      const kaspaRegex = /^kaspa:[a-z0-9]{61,63}$/;
      if (!kaspaRegex.test(senderAddress)) {
        return res.status(400).json({ error: "Invalid sender address format" });
      }
      if (!kaspaRegex.test(recipientAddress)) {
        return res
          .status(400)
          .json({ error: "Invalid recipient address format" });
      }

      // 3. Validate recipient ≠ sender
      if (recipientAddress === senderAddress) {
        return res
          .status(400)
          .json({ error: "Recipient address cannot equal sender address" });
      }

      // 4. Validate amount and fee
      if (amount <= 0) {
        return res
          .status(400)
          .json({ error: "Transfer amount must be greater than 0" });
      }
      if (fee < 0) {
        return res.status(400).json({ error: "Fee cannot be negative" });
      }

    const amountToSend = BigInt(Math.floor(amount * 1e8));
    const feeAmount = BigInt(Math.floor(fee * 1e8));
    const totalNeeded = amountToSend + feeAmount;

    const sk = new PrivateKey(privateKey);

    // Fetch UTXOs
    const { data: utxos } = await axios.get(
      `https://api.kaspa.org/addresses/${senderAddress}/utxos`
    );

    // Select multiple UTXOs to cover totalNeeded
    let inputs = [];
    let inputSum = BigInt(0);
    for (const u of utxos) {
      inputs.push(u);
      inputSum += BigInt(u.utxoEntry.amount);
      if (inputSum >= totalNeeded) break;
    }
    if (inputSum < totalNeeded) {
      return res.status(400).json({ error: "Insufficient UTXOs for requested amount" });
    }

    // Construct transaction
    const tx = new Transaction();
    tx.setVersion(0);

    // Add all selected UTXOs as inputs
    inputs.forEach(u => {
      tx.addInput(new Transaction.Input.PublicKey({
        prevTxId: u.outpoint.transactionId,
        outputIndex: u.outpoint.index,
        script: u.utxoEntry.scriptPublicKey.scriptPublicKey,
        sequenceNumber: 0,
        output: new Transaction.Output({
          script: u.utxoEntry.scriptPublicKey.scriptPublicKey,
          satoshis: Number(u.utxoEntry.amount),
        }),
      }));
    });

    // Calculate change
    const changeAmount = inputSum - totalNeeded;

    // Recipient output
    tx.addOutput(new Transaction.Output({
      script: new Script(new Address(recipientAddress)).toBuffer().toString('hex'),
      satoshis: Number(amountToSend)
    }));

    // Add change output only if above safe minimum (Kaspa recommends >0.02 KAS)
    if (changeAmount >= BigInt(Math.floor(0.02 * 1e8))) {
      tx.addOutput(new Transaction.Output({
        script: new Script(new Address(senderAddress)).toBuffer().toString("hex"),
        satoshis: Number(changeAmount),
      }));
    }

    // Sign all inputs
    const signedInputs = tx.inputs.map((input, index) => {
      const inputSignature = input.getSignatures(
        tx,
        sk,
        index,
        crypto.Signature.SIGHASH_ALL,
        null,
        "schnorr"
      )[0];
      const signature = inputSignature.signature
        .toBuffer("schnorr")
        .toString("hex");

      return {
        previousOutpoint: {
          transactionId: input.prevTxId.toString("hex"),
          index: input.outputIndex,
        },
        signatureScript: `41${signature}01`,
        sequence: input.sequenceNumber,
        sigOpCount: 1,
      };
    });

    // Prepare REST JSON
    const restApiJson = {
      transaction: {
        version: tx.version,
        inputs: signedInputs,
        outputs: tx.outputs.map(o => ({
          amount: o.satoshis,
          scriptPublicKey: {
            version: 0,
            scriptPublicKey: o.script.toBuffer().toString("hex"),
          },
        })),
        lockTime: 0,
        subnetworkId: "0000000000000000000000000000000000000000",
      },
      allowOrphan: true,
    };

    // Broadcast transaction
    const { data: txResponse } = await axios.post(
      "https://api.kaspa.org/transactions",
      restApiJson
    );

    // Fetch sender balance
    let balanceResp;
    try {
      balanceResp = await axios.get(`${KASPA_REST}/addresses/${senderAddress}/balance`);
    } catch (err) {
      balanceResp = { data: { balance: null } };
    }

    res.json({
      status: "OK",
      transactionId: txResponse.transactionId,
      rawTransaction: txResponse.rawTransaction,
      transferredAmount: amountToSend.toString(),
      chargedAmount: totalNeeded.toString(),
      walletBalance: balanceResp.data.balance,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: "Transaction creation failed",
      details: err.response?.data || err.message,
    });
  }
});


// ===== Transactions by Address (History) =====
app.get("/transactions/:address", async (req, res) => {
  const { address } = req.params;
  
  try {
    // Fetch full transactions for the given address
    const resp = await axios.get(`${KASPA_REST}/addresses/${address}/full-transactions`);

    // If no transactions found or invalid structure, return error
    if (!resp.data || resp.data.length === 0) {
      return res.status(404).json({
        status: "ERROR",
        error: "No transactions found for the address"
      });
    }

    // Process the transactions to check for self-transfers
    const transactions = resp.data.map(tx => {
      let isSelfTransfer = false;
      let isSent = false;
      let isReceived = false;

      // Extract the address from the inputs and outputs
      const inputAddresses = tx.inputs.map(input => input.previous_outpoint_address).filter(address => address !== null);
      const outputAddresses = tx.outputs.map(output => output.script_public_key_address);

      // Check if the given address is in inputs (sent)
      if (inputAddresses.includes(address)) {
        isSent = true;
      }

      // Check if the given address is in outputs (received)
      if (outputAddresses.includes(address)) {
        isReceived = true;
      }

      // Check if the address appears both in inputs and outputs (self-transfer)
      if (inputAddresses.includes(address) && outputAddresses.includes(address)) {
        isSelfTransfer = true;
      }

      // Add flags to the transaction
      return {
        ...tx,
        isSent,
        isReceived,
        isSelfTransfer
      };
    });

    // Respond with the transactions and their statuses
    res.json({
      status: "OK",
      transactions
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

const PORT = process.env.PORT || 8081;
app.listen(PORT, () => {
  console.log(`Kaspa API listening on port ${PORT}`);
});
