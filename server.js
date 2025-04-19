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
  // Input {} is valid per user verification.
  const mutation = gql`
    mutation CreateAuthSession($input: CreateAuthSessionInput!) {
      CreateAuthSession(input: $input) {
        id                # Auth Session ID
        state             # Initial state (e.g., PENDING)
        authenticationUrl # URL to be encoded into QR code by frontend
      }
    }
  `;

  try {
    console.log("Requesting auth session from Enjin Platform...");
    const variables = { input: {} }; // Empty input is valid
    const data = await request({
      url: PLATFORM_URL,
      document: mutation,
      variables: variables,
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    const authData = data?.CreateAuthSession;

    if (!authData?.id || !authData?.authenticationUrl) {
        console.error("Unexpected response structure from CreateAuthSession:", data);
        throw new Error("Failed to get required ID or authenticationUrl from auth response.");
    }

    console.log("Auth session created successfully:", authData);
    res.json(authData); // Return the data containing id, state, and authenticationUrl

  } catch (err) {
    console.error("Auth error:", err.response?.errors || err.message);
     if (err.response?.errors) {
        console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2));
    }
    res.status(500).json({ error: "Auth failed", details: err.message });
  }
});

// Step 2: Check Authentication Status (Polling)
app.get("/check-auth/:authSessionId", async (req, res) => { // Renamed param for clarity
    const { authSessionId } = req.params;
    if (!authSessionId) {
        return res.status(400).json({ error: "Auth session ID is required" });
    }

    // Using the verified query 'GetAuthSession'
    const query = gql`
      query GetAuthSession($id: ID!) { # <-- Correct Query name
        GetAuthSession(id: $id) {      # <-- Correct Query name
          id
          state                      # Can check state if needed (e.g., wait for AUTHENTICATED)
          wallet {
            id                       # Correct path for CAIP-10 wallet ID
            # account # Also available if needed
          }
        }
      }
    `;

    try {
      const data = await request({
        url: PLATFORM_URL,
        document: query,
        variables: { id: authSessionId }, // Use ID! type
        requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });

      // Access wallet ID using the correct path
      const walletId = data?.GetAuthSession?.wallet?.id;
      const sessionState = data?.GetAuthSession?.state;
      console.log(`Polling auth session ${authSessionId}: State=${sessionState}, Wallet=${walletId || 'N/A'}`);

      // Only return address if wallet ID exists (implies successful link)
      // You might want to add a check for sessionState === 'AUTHENTICATED' or similar if needed
      if (walletId) {
        res.json({ address: walletId });
      } else {
        res.json({ address: null }); // Not authenticated or wallet not linked yet
      }
    } catch (err) {
      if (err.response?.errors) {
          console.error("Check auth GraphQL error:", err.response.errors);
          // Session not found likely means expired or invalid ID
          if (err.response.errors.some(e => e.message.includes("not found"))) {
             return res.status(404).json({ address: null, error: "Auth session not found or expired." });
          }
      } else {
          console.error("Check auth network/request error:", err.message);
      }
      // Return success but null address if session exists but wallet not linked yet
      res.status(200).json({ address: null, error: "Failed to check auth status or wallet not linked." });
    }
});


// Step 3: Mint 5 Tokens after user scans QR and approves payment
app.post("/mint", async (req, res) => {
  const { authTokenId } = req.body; // Keep variable name consistent with frontend call for now
  const authSessionId = authTokenId; // Use a clearer internal variable name
  if (!authSessionId) {
    return res.status(400).json({ error: "Auth session ID is required" });
  }

  let userWallet = null;
  let chargeTransactionId = null;

  try {
    // --- Get Wallet Address using the verified GetAuthSession query ---
    console.log(`Mint request received for authSessionId: ${authSessionId}`);
    const getWalletQuery = gql`
      query GetAuthSessionWallet($id: ID!) { # <-- Correct Query name
        GetAuthSession(id: $id) {           # <-- Correct Query name
          state
          wallet {
            id                            # Correct path for CAIP-10 wallet ID
          }
        }
      }
    `;
    const { GetAuthSession } = await request({ // <-- Use correct query name
      url: PLATFORM_URL,
      document: getWalletQuery,
      variables: { id: authSessionId }, // Use ID! type
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    // Access wallet ID using the correct path
    userWallet = GetAuthSession?.wallet?.id;
    const sessionState = GetAuthSession?.state;

    // Ensure session is in a state where wallet is linked before proceeding
    // Add specific state checks if necessary (e.g., state === 'AUTHENTICATED')
    if (!userWallet) {
      throw new Error(`Wallet not linked to session ${authSessionId} or session state (${sessionState}) is invalid.`);
    }
    console.log(`User wallet identified: ${userWallet} from session state: ${sessionState}`);

    // --- Initiate Charge ENJ ---
    // Assuming CreateTransaction still correctly links via authTokenId (session ID)
    // !!! IMPORTANT: Verify if CreateTransaction input needs authSessionId or similar !!!
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
        authTokenId: authSessionId, // <-- Verify if this field name is correct for linking
      },
    };
    const chargeTxResult = await request({ url: PLATFORM_URL, document: txMutation, variables: txVars, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });

    chargeTransactionId = chargeTxResult?.CreateTransaction?.id; // Adjust access based on verified mutation name
    const initialState = chargeTxResult?.CreateTransaction?.state; // Adjust access
    if (!chargeTransactionId) { throw new Error("Failed to initiate charge transaction request."); }
    console.log(`Charge transaction request created: ID=${chargeTransactionId}, State=${initialState}`);

    // --- Monitor Charge Transaction Status ---
    console.log(`Monitoring charge transaction status (ID: ${chargeTransactionId})...`);
    const startTime = Date.now();
    let chargeSucceeded = false;
    const getTxStateQuery = gql` query GetTransactionState($id: String!) { Transaction(id: $id) { state } } `; // Verify Query/Field

    while (Date.now() - startTime < TX_POLL_TIMEOUT_MS) {
        await delay(TX_POLL_INTERVAL_MS);
        try {
            const txStateResult = await request({ url: PLATFORM_URL, document: getTxStateQuery, variables: { id: chargeTransactionId }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
            const currentState = txStateResult?.Transaction?.state; // Verify path
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
    const mintMutation = gql` mutation BatchMint($collectionId: BigInt!, $recipients: [BatchMintRecipientInput!]!) { BatchMint(collectionId: $collectionId, recipients: $recipients) { id state method } } `; // Verified mutation
    console.log(`Attempting batch mint for ${MINT_COUNT} tokens...`);
    const mintResult = await request({ url: PLATFORM_URL, document: mintMutation, variables: { collectionId: COLLECTION_ID, recipients: batchRecipients }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    console.log("Batch mint request created:", mintResult.BatchMint); // Access using correct mutation name

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
