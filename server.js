require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { request, gql } = require("graphql-request");

const app = express();
// Use the PORT environment variable provided by Render or default to 5000
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

app.use(cors()); // Enable CORS for all routes
app.use(bodyParser.json());

// --- Configuration ---
const PLATFORM_URL = process.env.PLATFORM_URL;
const AUTH_TOKEN = process.env.ENJIN_API_TOKEN; // Ensure this is set in Render Env Vars
const COLLECTION_ID = parseInt(process.env.COLLECTION_ID);
const RECEIVER_WALLET = process.env.RECEIVER_WALLET; // Admin/Treasury wallet

const TOKEN_IDS = [1, 2, 3]; // Available token IDs to mint randomly
const TOKEN_NAMES = { 1: "Rock", 2: "Paper", 3: "Scissors" };
const MINT_COUNT = 5; // Number of tokens to mint per request
const MINT_COST_ENJ = "10"; // Cost in ENJ for the pack of 5 (Update if cost changes)
// Convert ENJ to Witoshi (1 ENJ = 10^18 Witoshi)
const MINT_COST_WITOSHI = (BigInt(MINT_COST_ENJ) * BigInt(10 ** 18)).toString();
const TX_POLL_INTERVAL_MS = 3000; // Poll transaction status every 3 seconds
const TX_POLL_TIMEOUT_MS = 120000; // Wait a maximum of 2 minutes for transaction confirmation


// --- Helper Functions ---
function getRandomTokenId() {
    return TOKEN_IDS[Math.floor(Math.random() * TOKEN_IDS.length)];
}

// Helper function to delay execution
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- API Endpoints ---

// Step 1: Start wallet verification process
app.get("/start-auth", async (req, res) => {
  // Using the RequestAccount query based on new docs
  const query = gql`
    query RequestAccount {
      RequestAccount {
        qrCode          # URL pointing to the QR code image
        verificationId  # ID to use for polling verification status
      }
    }
  `;

  try {
    console.log("Requesting account verification from Enjin Platform...");
    const data = await request({
      url: PLATFORM_URL,
      document: query,
      // No variables needed for RequestAccount query
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    const verificationData = data?.RequestAccount;

    if (!verificationData?.verificationId || !verificationData?.qrCode) {
        console.error("Unexpected response structure from RequestAccount:", data);
        throw new Error("Failed to get required verificationId or qrCode from RequestAccount response.");
    }

    console.log("Account verification request initiated:", verificationData);
    // Return the data containing verificationId and qrCode URL
    res.json(verificationData);

  } catch (err) {
    console.error("Verification request error:", err.response?.errors || err.message);
     if (err.response?.errors) {
        console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2));
    }
    res.status(500).json({ error: "Verification request failed", details: err.message });
  }
});

// Step 2: Check Verification Status (Polling)
app.get("/check-auth/:verificationId", async (req, res) => { // Renamed param
    const { verificationId } = req.params;
    if (!verificationId) {
        return res.status(400).json({ error: "Verification ID is required" });
    }

    // Using the GetAccountVerified query based on new docs
    const query = gql`
      query GetAccountVerified($verificationId: String!) { # Use String! type based on example
        GetAccountVerified(verificationId: $verificationId) {
          verified
          account {
            address # CAIP-10 address format based on example
          }
        }
      }
    `;

    try {
      const data = await request({
        url: PLATFORM_URL,
        document: query,
        variables: { verificationId: verificationId },
        requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });

      const verificationStatus = data?.GetAccountVerified;
      const isVerified = verificationStatus?.verified;
      const walletAddress = verificationStatus?.account?.address;

      console.log(`Polling verification ${verificationId}: Verified=${isVerified}, Wallet=${walletAddress || 'N/A'}`);

      if (isVerified && walletAddress) {
        res.json({ address: walletAddress }); // Return address only if verified
      } else {
        res.json({ address: null }); // Not verified yet
      }
    } catch (err) {
      if (err.response?.errors) {
          console.error("Check verification GraphQL error:", err.response.errors);
          if (err.response.errors.some(e => e.message.includes("not found"))) {
             return res.status(404).json({ address: null, error: "Verification ID not found or expired." });
          }
      } else {
          console.error("Check verification network/request error:", err.message);
      }
      res.status(200).json({ address: null, error: "Failed to check verification status." });
    }
});


// Step 3: Mint 5 Tokens
app.post("/mint", async (req, res) => {
  // Frontend will send the 'verificationId' obtained from /start-auth
  // We'll keep calling it 'authTokenId' in the request body for now to minimize frontend changes,
  // but use 'verificationId' internally for clarity.
  const { authTokenId } = req.body;
  const verificationId = authTokenId;
  if (!verificationId) {
    return res.status(400).json({ error: "Verification ID (authTokenId) is required" });
  }

  let userWallet = null;
  let chargeTransactionId = null;

  try {
    // --- Get Wallet Address using GetAccountVerified ---
    // We need to re-verify and get the address associated with the verificationId
    console.log(`Mint request received for verificationId: ${verificationId}`);
    const getWalletQuery = gql`
      query GetVerifiedWalletForMint($verificationId: String!) {
        GetAccountVerified(verificationId: $verificationId) {
          verified
          account {
            address
          }
        }
      }
    `;
    const { GetAccountVerified } = await request({
      url: PLATFORM_URL,
      document: getWalletQuery,
      variables: { verificationId: verificationId },
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    userWallet = GetAccountVerified?.verified ? GetAccountVerified?.account?.address : null;

    if (!userWallet) {
      throw new Error(`Wallet not verified or found for verification ID ${verificationId}.`);
    }
    console.log(`User wallet identified for minting: ${userWallet}`);

    // --- Initiate Charge ENJ ---
    // !!! UNCERTAINTY WARNING !!!
    // The 'RequestAccount' flow doesn't explicitly state how to authorize this transaction.
    // The 'CreateTransaction' mutation might fail if it requires an 'authTokenId' from
    // 'CreateAuthSession' instead of just being called after verification.
    // We are proceeding assuming it *might* work, but it needs testing.
    console.log(`Requesting ${MINT_COST_ENJ} cENJ charge transaction...`);
    const txMutation = gql`
      mutation CreateTransaction($input: CreateTransactionInput!) {
        CreateTransaction(input: $input) {
          id
          state
        }
      }
    `;
    const txVars = {
      input: {
        recipient: RECEIVER_WALLET,
        value: MINT_COST_WITOSHI,
        // Does CreateTransaction need the user's verified address? Or the verificationId?
        // Or does it just work because the user approved the *linking* via QR? This is unclear.
        // Passing the verificationId here as 'authTokenId' based on previous structure,
        // but this is the most likely point of failure.
        authTokenId: verificationId, // <-- HIGHLY UNCERTAIN if this works
      },
    };
    const chargeTxResult = await request({ url: PLATFORM_URL, document: txMutation, variables: txVars, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });

    chargeTransactionId = chargeTxResult?.CreateTransaction?.id;
    const initialState = chargeTxResult?.CreateTransaction?.state;
    if (!chargeTransactionId) { throw new Error("Failed to initiate charge transaction request."); }
    console.log(`Charge transaction request created: ID=${chargeTransactionId}, State=${initialState}`);

    // --- Monitor Charge Transaction Status ---
    console.log(`Monitoring charge transaction status (ID: ${chargeTransactionId})...`);
    const startTime = Date.now();
    let chargeSucceeded = false;
    const getTxStateQuery = gql` query GetTransactionState($id: String!) { Transaction(id: $id) { state } } `;

    while (Date.now() - startTime < TX_POLL_TIMEOUT_MS) {
        await delay(TX_POLL_INTERVAL_MS);
        try {
            const txStateResult = await request({ url: PLATFORM_URL, document: getTxStateQuery, variables: { id: chargeTransactionId }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
            const currentState = txStateResult?.Transaction?.state;
            console.log(`Polling charge TX ${chargeTransactionId}: State = ${currentState}`);
            const successStates = ["EXECUTED", "CONFIRMED", "COMPLETED"]; // Verify these!
            const failureStates = ["FAILED", "CANCELED", "REJECTED", "EXPIRED"]; // Verify these!
            if (successStates.includes(currentState)) { console.log("✅ Charge transaction successful!"); chargeSucceeded = true; break; }
            if (failureStates.includes(currentState)) { console.error(`❌ Charge transaction failed or was rejected. State: ${currentState}`); throw new Error(`Payment failed or was rejected by the user (State: ${currentState}).`); }
        } catch (pollError) {
             console.error(`Error polling transaction ${chargeTransactionId}:`, pollError.message);
             if (pollError.response?.errors?.some(e => e.message.includes("not found"))) { throw new Error(`Charge transaction ${chargeTransactionId} not found. It might have expired or been invalid.`); }
        }
    } // End polling loop
    if (!chargeSucceeded) { throw new Error("Payment confirmation timed out. Please try again."); }

    // --- Minting Logic (Only runs if charge succeeded) ---
    console.log("Payment confirmed. Proceeding with minting...");
    const tokensToMintDetails = [];
    for (let i = 0; i < MINT_COUNT; i++) { const randomId = getRandomTokenId(); tokensToMintDetails.push({ id: randomId, name: TOKEN_NAMES[randomId] || `Token ${randomId}` }); }
    console.log(`Generated tokens to mint: ${tokensToMintDetails.map(t => t.name).join(', ')}`);
    const batchRecipients = tokensToMintDetails.map(token => ({ account: userWallet, mintParams: { amount: 1, tokenId: { integer: token.id } } }));
    const mintMutation = gql` mutation BatchMint($collectionId: BigInt!, $recipients: [BatchMintRecipientInput!]!) { BatchMint(collectionId: $collectionId, recipients: $recipients) { id state method } } `;
    console.log(`Attempting batch mint for ${MINT_COUNT} tokens...`);
    const mintResult = await request({ url: PLATFORM_URL, document: mintMutation, variables: { collectionId: COLLECTION_ID, recipients: batchRecipients }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    console.log("Batch mint request created:", mintResult.BatchMint);

    res.json({ success: true, mintedTokens: tokensToMintDetails });

  } catch (err) {
    console.error("Mint process error:", err.message);
    if (err.response?.errors) { console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2)); }
    res.status(500).json({ error: "Mint process failed.", details: err.message });
  }
});

// --- Other Endpoints (Balances, Supply) - Unchanged ---
app.get("/balances/:wallet", async (req, res) => { /* ... unchanged ... */ });
app.get("/supply", async (req, res) => { /* ... unchanged ... */ });
app.get("/", (req, res) => { res.send("RPS Minting Backend is running."); });
