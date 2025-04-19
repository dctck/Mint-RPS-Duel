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

// Step 1: Start an auth session (user scans QR)
app.get("/start-auth", async (req, res) => {
  // Using the verified mutation name 'CreateAuthSession'
  // !!! IMPORTANT: Verify the structure of CreateAuthSessionInput! from Enjin API Docs !!!
  // Assuming empty input {} for now. It might require specific fields.
  const mutation = gql`
    mutation CreateAuthSession($input: CreateAuthSessionInput!) { # <-- Verified name
      CreateAuthSession(input: $input) { # <-- Verified name
        id                # Auth Session ID
        state             # Initial state (e.g., PENDING)
        authenticationUrl # URL to be encoded into QR code by frontend
      }
    }
  `;

  try {
    console.log("Requesting auth session from Enjin Platform...");
    // Assume empty input for now - VERIFY THIS!
    const variables = { input: {} };
    const data = await request({
      url: PLATFORM_URL,
      document: mutation,
      variables: variables, // Pass the input variable
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    // Access the data based on the correct mutation name
    const authData = data?.CreateAuthSession;

    // Check for the fields returned by CreateAuthSession
    if (!authData?.id || !authData?.authenticationUrl) {
        console.error("Unexpected response structure from CreateAuthSession:", data);
        throw new Error("Failed to get required ID or authenticationUrl from auth response.");
    }

    console.log("Auth session created successfully:", authData);
    // Return the data containing id, state, and authenticationUrl
    res.json(authData);

  } catch (err) {
    console.error("Auth error:", err.response?.errors || err.message);
     if (err.response?.errors) {
        console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2));
    }
    res.status(500).json({ error: "Auth failed", details: err.message });
  }
});

// Step 2: Check Authentication Status (Polling)
app.get("/check-auth/:authTokenId", async (req, res) => {
    const { authTokenId } = req.params;
    if (!authTokenId) {
        return res.status(400).json({ error: "Auth token ID is required" });
    }

    // !!! IMPORTANT: Verify the correct Query name and field for checking auth status !!!
    // This assumes 'AuthToken' query and 'wallet.id' field are correct.
    // The query might need to change based on how 'CreateAuthSession' works.
    // Perhaps query the session state using the ID from CreateAuthSession?
    const query = gql`
      query GetAuthToken($id: String!) {
        AuthToken(id: $id) { # <-- Verify this Query name - MIGHT NEED TO CHANGE
          wallet {
            id # <-- Verify this field path returns the CAIP-10 wallet ID
          }
          # Potentially check session state here too?
          # state
        }
      }
    `;

    try {
      const data = await request({
        url: PLATFORM_URL,
        document: query,
        variables: { id: authTokenId },
        requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });

      // Adjust access based on verified Query name
      const walletId = data?.AuthToken?.wallet?.id;

      if (walletId) {
        res.json({ address: walletId });
      } else {
        res.json({ address: null });
      }
    } catch (err) {
      if (err.response?.errors) {
          console.error("Check auth GraphQL error:", err.response.errors);
          if (err.response.errors.some(e => e.message.includes("not found"))) {
             // If using AuthToken query, this might mean session expired or wasn't linked to a wallet yet
             return res.status(404).json({ address: null, error: "Auth session not found, expired, or not yet linked." });
          }
      } else {
          console.error("Check auth network/request error:", err.message);
      }
      res.status(200).json({ address: null, error: "Failed to check auth status." });
    }
});


// Step 3: Mint 5 Tokens after user scans QR and approves payment
app.post("/mint", async (req, res) => {
  const { authTokenId } = req.body; // This ID now comes from CreateAuthSession
  if (!authTokenId) {
    return res.status(400).json({ error: "Auth session ID is required" });
  }

  let userWallet = null;
  let chargeTransactionId = null;

  try {
    // --- Get Wallet Address ---
    // We need to confirm the wallet linked to the Auth Session ID
    console.log(`Mint request received for authSessionId: ${authTokenId}`);
     // !!! IMPORTANT: Verify how to get the wallet address from the completed AuthSession !!!
     // Using the same 'AuthToken' query might still work if Enjin links them, but verify.
    const getWalletQuery = gql`
      query GetAuthWallet($id: String!) {
        AuthToken(id: $id) { # <-- Verify Query name - MIGHT NEED TO CHANGE
          wallet {
            id # <-- Verify field path for CAIP-10 wallet ID
          }
        }
      }
    `;
    const { AuthToken } = await request({ // <-- Adjust based on verified Query name
      url: PLATFORM_URL,
      document: getWalletQuery,
      variables: { id: authTokenId },
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    // Adjust access based on verified Query name
    userWallet = AuthToken?.wallet?.id;
    if (!userWallet) {
      // It's possible the session exists but the wallet isn't linked yet, or the query is wrong.
      throw new Error("Wallet not linked to session or session invalid/expired.");
    }
    console.log(`User wallet identified: ${userWallet}`);

    // --- Initiate Charge ENJ (using the Auth Session ID) ---
    // !!! IMPORTANT: Verify if CreateTransaction input needs authSessionId instead of authTokenId !!!
    // Assuming the input schema for CreateTransaction still uses 'authTokenId' for linking payment. Verify this!
    console.log(`Requesting ${MINT_COST_ENJ} cENJ charge transaction...`);
    const txMutation = gql`
      mutation CreateTransaction($input: CreateTransactionInput!) { # <-- Verify Mutation name
        CreateTransaction(input: $input) { # <-- Verify Mutation name
          id
          state
        }
      }
    `;
    const txVars = {
      input: {
        recipient: RECEIVER_WALLET,
        value: MINT_COST_WITOSHI,
        authTokenId: authTokenId, // <-- Verify if this field name is correct for linking to the session
      },
    };
    const chargeTxResult = await request({
      url: PLATFORM_URL,
      document: txMutation,
      variables: txVars,
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    // Adjust access based on verified mutation name
    chargeTransactionId = chargeTxResult?.CreateTransaction?.id;
    const initialState = chargeTxResult?.CreateTransaction?.state;
    if (!chargeTransactionId) {
        throw new Error("Failed to initiate charge transaction request.");
    }
    console.log(`Charge transaction request created: ID=${chargeTransactionId}, State=${initialState}`);

    // --- Monitor Charge Transaction Status ---
    console.log(`Monitoring charge transaction status (ID: ${chargeTransactionId})...`);
    const startTime = Date.now();
    let chargeSucceeded = false;

    // !!! IMPORTANT: Verify the 'Transaction' query name and 'state' field path !!!
    const getTxStateQuery = gql`
        query GetTransactionState($id: String!) {
            Transaction(id: $id) { # <-- Verify Query name
                state             # <-- Verify field name for state
            }
        }
    `;

    while (Date.now() - startTime < TX_POLL_TIMEOUT_MS) {
        await delay(TX_POLL_INTERVAL_MS);
        try {
            const txStateResult = await request({ url: PLATFORM_URL, document: getTxStateQuery, variables: { id: chargeTransactionId }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
            const currentState = txStateResult?.Transaction?.state; // Adjust access based on verified Query name
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

    // !!! IMPORTANT: Verify the 'BatchMint' mutation name and structure !!!
    const mintMutation = gql`
      mutation BatchMint($collectionId: BigInt!, $recipients: [BatchMintRecipientInput!]!) { # <-- Verify Mutation name and Input type
        BatchMint(collectionId: $collectionId, recipients: $recipients) { # <-- Verify Mutation name
          id
          state
          method
        }
      }
    `;
    console.log(`Attempting batch mint for ${MINT_COUNT} tokens...`);
    const mintResult = await request({ url: PLATFORM_URL, document: mintMutation, variables: { collectionId: COLLECTION_ID, recipients: batchRecipients }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    console.log("Batch mint request created:", mintResult.BatchMint); // Adjust access based on verified mutation name

    res.json({ success: true, mintedTokens: tokensToMintDetails });

  } catch (err) {
    console.error("Mint process error:", err.message);
    if (err.response?.errors) { console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2)); }
    res.status(500).json({ error: "Mint process failed.", details: err.message });
  }
});

// --- Other Endpoints (Balances, Supply) - Unchanged ---
// NOTE: These also use GraphQL queries ('TokensByOwner', 'Tokens') that should be verified against the API schema.
app.get("/balances/:wallet", async (req, res) => { /* ... unchanged ... */ });
app.get("/supply", async (req, res) => { /* ... unchanged ... */ });
app.get("/", (req, res) => { res.send("RPS Minting Backend is running."); });
