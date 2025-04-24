require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { request, gql } = require("graphql-request");
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

app.use(cors());
app.use(bodyParser.json());

// --- Configuration ---
const PLATFORM_URL = process.env.PLATFORM_URL;
const AUTH_TOKEN = process.env.ENJIN_API_TOKEN; // Admin/Backend API Token
const COLLECTION_ID = parseInt(process.env.COLLECTION_ID || '0'); // Ensure COLLECTION_ID is set in env
const RECEIVER_WALLET = process.env.RECEIVER_WALLET; // Ensure RECEIVER_WALLET is set in env

const TOKEN_IDS = [1, 2, 3]; // Available token IDs to mint randomly
const TOKEN_NAMES = { 1: "Rock", 2: "Paper", 3: "Scissors" };
const MINT_COUNT = 5; // Number of tokens to mint per request
const MINT_COST_ENJ = "10"; // Cost in ENJ for the pack of 5
const MINT_COST_WITOSHI = (BigInt(MINT_COST_ENJ) * BigInt(10 ** 18)).toString();
const TX_POLL_INTERVAL_MS = 3000; // Poll transaction status every 3 seconds
const TX_POLL_TIMEOUT_MS = 120000; // Wait a maximum of 2 minutes for transaction confirmation

// --- Helper Functions ---
function getRandomTokenId() {
    return TOKEN_IDS[Math.floor(Math.random() * TOKEN_IDS.length)];
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- API Endpoints ---

// Step 1: Start wallet verification process using RequestAccount query
app.get("/start-auth", async (req, res) => {
  const query = gql`
    query RequestAccount {
      RequestAccount {
        qrCode
        verificationId
      }
    }
  `;
  try {
    console.log("Requesting account verification from Enjin Platform...");
    const data = await request({ url: PLATFORM_URL, document: query, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const verificationData = data?.RequestAccount;
    if (!verificationData?.verificationId || !verificationData?.qrCode) { throw new Error("Failed to get required verificationId or qrCode from RequestAccount response."); }
    console.log("Account verification request initiated:", verificationData);
    res.json(verificationData);
  } catch (err) { console.error("Verification request error:", err.response?.errors || err.message); if (err.response?.errors) { console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2)); } else if (err.response?.error) { console.error("Raw API Error Response:", err.response.error); } res.status(500).json({ error: "Verification request failed", details: err.message }); }
});

// Step 2: Check Authentication Status (Polling) using GetWallet query
app.get("/check-auth/:verificationId", async (req, res) => {
    const { verificationId } = req.params;
    if (!verificationId) { return res.status(400).json({ error: "Verification ID is required" }); }
    // Also fetch internal wallet ID (id) needed for /balances query
    const query = gql`
      query GetVerifiedWallet($verificationId: String!) {
        GetWallet(verificationId: $verificationId) {
          id # Internal Wallet ID
          account { address }
          balances { free }
        }
      }
    `;
    try {
      const data = await request({ url: PLATFORM_URL, document: query, variables: { verificationId: verificationId }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
      const walletData = data?.GetWallet;
      const walletAddress = walletData?.account?.address;
      const enjBalanceWitoshi = walletData?.balances?.free ?? null;
      const internalWalletId = walletData?.id ?? null; // Get internal ID
      console.log(`Polling verification ${verificationId}: WalletData=${walletData ? 'Found' : 'Null'}, Address=${walletAddress || 'N/A'}, Balance=${enjBalanceWitoshi ?? 'N/A'}, WalletID=${internalWalletId ?? 'N/A'}`);
      if (walletData && walletAddress && internalWalletId) {
          res.json({
              address: walletAddress,
              balance: enjBalanceWitoshi,
              walletId: internalWalletId // Send internal ID to frontend
          });
      }
      else { res.json({ address: null, balance: null, walletId: null }); }
    } catch (err) { if (err.response?.errors) { console.error("Check verification GraphQL error:", err.response.errors); } else { console.error("Check verification network/request error:", err.message); } res.status(200).json({ address: null, balance: null, walletId: null, error: "Failed to check verification status or not yet verified." }); }
});

// Step 3: Mint 5 Tokens (Corrected Structure - Requires OAuth Token)
app.post("/mint", async (req, res) => {
  // --- EXPECT OAUTH TOKEN FROM FRONTEND ---
  // Frontend needs to send the user's OAuth token obtained via a separate flow.
  // The 'authTokenId' field name is kept here temporarily for compatibility with the
  // current frontend request, but the VALUE should be the OAuth token.
  // Ideally, the frontend request body key should also be changed to 'authToken'.
  const { authTokenId: userOAuthToken } = req.body; // Read OAuth token from request body

  if (!userOAuthToken) {
    // Changed error message to reflect the need for an OAuth token
    return res.status(400).json({ error: "User OAuth token (authTokenId) is required" });
  }

  // --- NO LONGER NEED TO FETCH WALLET ADDRESS HERE ---
  // The OAuth token implicitly identifies the user for the transaction.
  // We still need the user's address for the BatchMint recipient field later.
  // This needs to be obtained and stored on the frontend after connection.
  // For now, we'll assume the frontend will also send userWalletAddress if needed,
  // OR BatchMint might implicitly use the OAuth token's associated wallet.
  // --> This part needs clarification based on how BatchMint uses the OAuth token. <--
  // Let's assume BatchMint uses the OAuth token to identify the recipient for now.
  // We'll remove the GetWallet call here.

  let chargeTransactionId = null;

  try {
    // --- Initiate Charge ENJ ---
    // Using the user's OAuth token to authorize the payment request.
    console.log(`Requesting ${MINT_COST_ENJ} cENJ charge transaction using user OAuth token...`);
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
        authToken: userOAuthToken, // <-- Use the CORRECT field 'authToken' with the OAuth token
      },
    };
    // Authorize this call using the BACKEND's API Token
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
            // Use BACKEND token to check transaction state
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

    // --- Determine Mint Recipient ---
    // How does BatchMint know who to mint to when authorized by an OAuth token?
    // Option 1: It implicitly mints to the wallet associated with the OAuth token.
    // Option 2: We still need the user's wallet address. The frontend would need
    //           to send the userWalletAddress obtained during connection along with the OAuth token.
    // Let's ASSUME Option 1 for now, where BatchMint uses the OAuth token context.
    // If this fails, the frontend needs modification to send the address.
    // const batchRecipients = tokensToMintDetails.map(token => ({ account: userWalletAddress, mintParams: { amount: 1, tokenId: { integer: token.id } } }));

    // --- Call BatchMint using BACKEND API Token ---
    // The mint itself is performed by the application (backend), not the user directly.
    const mintMutation = gql`
        mutation BatchMint($collectionId: BigInt!, $recipients: [BatchMintRecipientInput!]!) {
            BatchMint(collectionId: $collectionId, recipients: $recipients) {
                id state method
            }
        }
    `;
    // Construct recipients - Assuming BatchMint needs the address explicitly.
    // We need the user's address from the frontend connection phase.
    // THIS IS A PROBLEM - the current /mint endpoint doesn't receive the user address.
    // TEMPORARY FIX: Use RECEIVER_WALLET - this is WRONG but allows code structure.
    // NEEDS REFACTORING: Frontend must send user address to /mint endpoint.
    console.warn("Using RECEIVER_WALLET as mint recipient due to missing user address in /mint request. Needs fixing!");
    const batchRecipients = tokensToMintDetails.map(token => ({
        account: RECEIVER_WALLET, // <<<--- !!! NEEDS TO BE USER'S WALLET ADDRESS SENT FROM FRONTEND !!!
        mintParams: { amount: 1, tokenId: { integer: token.id } }
    }));


    console.log(`Attempting batch mint for ${MINT_COUNT} tokens...`);
    // Minting is done using the backend's authority (its API token)
    const mintResult = await request({ url: PLATFORM_URL, document: mintMutation, variables: { collectionId: COLLECTION_ID, recipients: batchRecipients }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    console.log("Batch mint request created:", mintResult.BatchMint);

    res.json({ success: true, mintedTokens: tokensToMintDetails });

  } catch (err) {
    console.error("Mint process error:", err.message);
    if (err.response?.errors) { console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2)); }
    res.status(500).json({ error: "Mint process failed.", details: err.message });
  }
});


// --- Other Endpoints (Balances, Supply) ---

// Get FT balances for a specific wallet - Using GetWallet query by internal ID
app.get("/balances/:walletID", async (req, res) => {
  const { walletID } = req.params; // This is the internal Wallet ID
  if (!walletID) { return res.status(400).json({ error: "Wallet ID required." }); }

  const COLLECTION_ID = parseInt(process.env.COLLECTION_ID || '0');
  const TOKEN_IDS_TO_CHECK = [1, 2, 3];

  // Use GetWallet by internal ID (Int!)
  const query = gql`
    query GetWalletTokenBalances($walletId: Int!, $collectionId: BigInt!, $tokenIds: [BigInt!]) {
      GetWallet(id: $walletId) { # Use internal ID
        tokenAccounts(
          collectionIds: [$collectionId]
          tokenIds: $tokenIds
          first: 10 # Adjust if needed
        ) {
          edges {
            node {
              token { tokenId }
              balance
            }
          }
        }
      }
    }
  `;

  const variables = {
    walletId: parseInt(walletID, 10), // Ensure it's an integer
    collectionId: COLLECTION_ID,
    tokenIds: TOKEN_IDS_TO_CHECK,
  };

  try {
    console.log(`Fetching FT balances for wallet ID: ${walletID}, collection: ${COLLECTION_ID}, tokens: ${TOKEN_IDS_TO_CHECK}`);
    const data = await request({ url: PLATFORM_URL, document: query, variables, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const balances = { "1": 0, "2": 0, "3": 0 };
    const edges = data?.GetWallet?.tokenAccounts?.edges;
    if (edges && Array.isArray(edges)) {
      edges.forEach(edge => {
        const node = edge?.node;
        if (node && node.token && node.token.tokenId && node.balance) {
          const tokenIdStr = node.token.tokenId.toString();
          if (balances.hasOwnProperty(tokenIdStr)) { balances[tokenIdStr] = parseInt(node.balance, 10); }
        }
      });
    } else { console.warn(`No tokenAccounts found for wallet ID ${walletID}.`); }
    console.log("FT Balances:", balances);
    res.json(balances);
  } catch (err) { console.error("Balance fetch error:", err.response?.errors || err.message); res.status(500).json({ error: "Could not get balances", details: err.message }); }
});


// Get supply - Using GetCollection query
app.get("/supply", async (req, res) => {
    const query = gql`
        query GetTotalFungibleSupply($collectionId: BigInt!) {
            GetCollection(id: $collectionId) {
                tokens(first: 100) {
                    edges {
                        node {
                            tokenId
                            supply
                            capSupply # Added capSupply
                        }
                    }
                }
            }
        }
    `;
    const COLLECTION_ID = parseInt(process.env.COLLECTION_ID || '0');
    const TOKEN_IDS_TO_CHECK = ["1", "2", "3"];

    try {
        console.log(`Fetching token supply for collection: ${COLLECTION_ID}`);
        const data = await request({ url: PLATFORM_URL, document: query, variables: { collectionId: COLLECTION_ID }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });

        let totalMinted = 0;
        let totalMaxSupply = 0; // Calculate max supply from data
        const edges = data?.GetCollection?.tokens?.edges;
        if (edges && Array.isArray(edges)) {
            edges.forEach(edge => {
                const node = edge?.node;
                if (node && node.tokenId && TOKEN_IDS_TO_CHECK.includes(node.tokenId.toString())) {
                    totalMinted += parseInt(node.supply || '0', 10);
                    totalMaxSupply += parseInt(node.capSupply || '0', 10);
                }
            });
        } else {
            console.warn("Could not accurately determine total minted supply from GetCollection query.");
            totalMaxSupply = 150; // Fallback if needed, adjust as necessary
        }

        const remaining = totalMaxSupply - totalMinted;
        console.log(`Total minted (IDs ${TOKEN_IDS_TO_CHECK.join(', ')}): ${totalMinted}, Total Max: ${totalMaxSupply}, Remaining: ${remaining}`);
        res.json({
            totalMinted, // Send total minted
            totalMaxSupply, // Send total max supply
            remaining: Math.max(0, remaining)
        });

    } catch (err) {
        console.error("Supply error:", err.response?.errors || err.message);
        if (err.response?.errors) { console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2)); }
        res.status(500).json({ error: "Could not fetch supply", details: err.message });
    }
});

// Basic root route (optional)
app.get("/", (req, res) => {
    res.send("RPS Auth Backend is running.");
});
```
