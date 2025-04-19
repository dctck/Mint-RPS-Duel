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
  const mutation = gql`
    mutation CreateAuthToken {
      CreateAuthToken {
        id
        qr # This should be a data URI (e.g., data:image/png;base64,...)
        expiresIn
      }
    }
  `;

  try {
    console.log("Requesting auth token from Enjin Platform...");
    const data = await request({
      url: PLATFORM_URL,
      document: mutation,
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    console.log("Auth token created successfully.");
    res.json(data.CreateAuthToken);
  } catch (err) {
    console.error("Auth error:", err.response?.errors || err.message);
    res.status(500).json({ error: "Auth failed", details: err.message });
  }
});

// Step 2: Check Authentication Status (Polling)
app.get("/check-auth/:authTokenId", async (req, res) => {
    const { authTokenId } = req.params;
    if (!authTokenId) {
        return res.status(400).json({ error: "Auth token ID is required" });
    }

    const query = gql`
      query GetAuthToken($id: String!) {
        AuthToken(id: $id) {
          wallet {
            id # This is the CAIP-10 wallet ID (e.g., eip155:1:0x...)
          }
        }
      }
    `;

    try {
      // console.log(`Checking auth status for token ID: ${authTokenId}`); // Optional: verbose logging
      const data = await request({
        url: PLATFORM_URL,
        document: query,
        variables: { id: authTokenId },
        requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });

      const walletId = data?.AuthToken?.wallet?.id;
      // console.log(`Auth status result: ${walletId ? 'Wallet found' : 'No wallet yet'}`); // Optional: verbose logging

      if (walletId) {
        res.json({ address: walletId }); // Return the CAIP-10 address
      } else {
        res.json({ address: null }); // Not authenticated yet
      }
    } catch (err) {
      // Handle cases where the token might expire or be invalid
      if (err.response?.errors) {
          console.error("Check auth GraphQL error:", err.response.errors);
          // Check for specific errors if needed, e.g., token not found
          if (err.response.errors.some(e => e.message.includes("not found"))) {
             return res.status(404).json({ address: null, error: "Auth token not found or expired." });
          }
      } else {
          console.error("Check auth network/request error:", err.message);
      }
      // Don't send 500 for polling checks unless it's an unexpected server error
      res.status(200).json({ address: null, error: "Failed to check auth status." }); // Indicate check failed but allow polling to continue
    }
});


// Step 3: Mint 5 Tokens after user scans QR and approves payment
app.post("/mint", async (req, res) => {
  const { authTokenId } = req.body;
  if (!authTokenId) {
    return res.status(400).json({ error: "Auth token ID is required" });
  }

  let userWallet = null;
  let chargeTransactionId = null;

  try {
    // --- Get Wallet Address ---
    console.log(`Mint request received for authTokenId: ${authTokenId}`);
    const getWalletQuery = gql`
      query GetAuthWallet($id: String!) {
        AuthToken(id: $id) {
          wallet {
            id # CAIP-10 wallet ID
          }
        }
      }
    `;
    const { AuthToken } = await request({
      url: PLATFORM_URL,
      document: getWalletQuery,
      variables: { id: authTokenId },
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    userWallet = AuthToken?.wallet?.id;
    if (!userWallet) {
      throw new Error("Wallet not found or authentication expired.");
    }
    console.log(`User wallet identified: ${userWallet}`);

    // --- Initiate Charge ENJ (using the Auth Token) ---
    console.log(`Requesting ${MINT_COST_ENJ} cENJ charge transaction...`);
    const txMutation = gql`
      mutation CreateTransaction($input: CreateTransactionInput!) {
        CreateTransaction(input: $input) {
          id      # The ID of the transaction request
          state   # Initial state (e.g., PENDING_USER_CONFIRMATION)
        }
      }
    `;
    const txVars = {
      input: {
        recipient: RECEIVER_WALLET, // Your treasury/admin wallet
        value: MINT_COST_WITOSHI, // Cost for the pack
        authTokenId, // Links this transaction request to the user's auth session
      },
    };
    const chargeTxResult = await request({
      url: PLATFORM_URL,
      document: txMutation,
      variables: txVars,
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

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

    // Define the query to get transaction state
    const getTxStateQuery = gql`
        query GetTransactionState($id: String!) {
            Transaction(id: $id) {
                state
                # Include error fields if available in the schema
                # error { message code }
            }
        }
    `;

    while (Date.now() - startTime < TX_POLL_TIMEOUT_MS) {
        await delay(TX_POLL_INTERVAL_MS); // Wait before checking status

        try {
            const txStateResult = await request({
                url: PLATFORM_URL,
                document: getTxStateQuery,
                variables: { id: chargeTransactionId },
                requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` }, // Use admin token to query tx state
            });

            const currentState = txStateResult?.Transaction?.state;
            console.log(`Polling charge TX ${chargeTransactionId}: State = ${currentState}`);

            // *** IMPORTANT: Adjust these state names based on Enjin Platform API documentation ***
            // Common success states might include EXECUTED, CONFIRMED, COMPLETED
            // Common failure states might include FAILED, CANCELED, REJECTED, EXPIRED
            const successStates = ["EXECUTED", "CONFIRMED", "COMPLETED"]; // Verify these!
            const failureStates = ["FAILED", "CANCELED", "REJECTED", "EXPIRED"]; // Verify these!

            if (successStates.includes(currentState)) {
                console.log("✅ Charge transaction successful!");
                chargeSucceeded = true;
                break; // Exit polling loop
            }

            if (failureStates.includes(currentState)) {
                console.error(`❌ Charge transaction failed or was rejected. State: ${currentState}`);
                throw new Error(`Payment failed or was rejected by the user (State: ${currentState}).`);
            }

            // Otherwise, continue polling (state is still pending)

        } catch (pollError) {
             console.error(`Error polling transaction ${chargeTransactionId}:`, pollError.message);
             if (pollError.response?.errors?.some(e => e.message.includes("not found"))) {
                 throw new Error(`Charge transaction ${chargeTransactionId} not found. It might have expired or been invalid.`);
             }
             // Optionally add more robust error handling for polling issues
        }
    } // End polling loop

    // Check if polling timed out
    if (!chargeSucceeded) {
        console.error(`Polling for charge transaction ${chargeTransactionId} timed out after ${TX_POLL_TIMEOUT_MS / 1000} seconds.`);
        throw new Error("Payment confirmation timed out. Please try again.");
    }

    // --- Minting Logic (Only runs if charge succeeded) ---
    console.log("Payment confirmed. Proceeding with minting...");

    // --- Generate 5 Random Token IDs ---
    const tokensToMintDetails = [];
    for (let i = 0; i < MINT_COUNT; i++) {
        const randomId = getRandomTokenId();
        tokensToMintDetails.push({
            id: randomId,
            name: TOKEN_NAMES[randomId] || `Token ${randomId}`
        });
    }
    console.log(`Generated tokens to mint: ${tokensToMintDetails.map(t => t.name).join(', ')}`);

    // --- Prepare Batch Mint Input based on documentation ---
    const batchRecipients = tokensToMintDetails.map(token => ({
        account: userWallet, // Recipient address (user's wallet)
        mintParams: {
            amount: 1, // Amount to mint
            tokenId: { integer: token.id } // Token ID to mint
        }
    }));

    // --- Define and Call the BatchMint Mutation ---
    // Input type BatchMintRecipientInput is inferred from docs structure
    const mintMutation = gql`
      mutation BatchMint($collectionId: BigInt!, $recipients: [BatchMintRecipientInput!]!) {
        BatchMint(collectionId: $collectionId, recipients: $recipients) {
          id      # Transaction/Request ID for the batch mint
          state   # State of the batch mint request
          method
        }
      }
    `;

    console.log(`Attempting batch mint for ${MINT_COUNT} tokens...`);
    const mintResult = await request({
        url: PLATFORM_URL,
        document: mintMutation,
        variables: {
            collectionId: COLLECTION_ID,
            recipients: batchRecipients
        },
        requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` }, // Use admin token for minting
    });
    console.log("Batch mint request created:", mintResult.BatchMint);
    // NOTE: Again, you might want to monitor this mint transaction state for final confirmation.

    // --- Format Success Response ---
    res.json({
      success: true,
      mintedTokens: tokensToMintDetails, // Return array of generated/attempted token details
    });

  } catch (err) {
    // Log detailed errors on the server
    console.error("Mint process error:", err.message); // Log the specific error that broke the flow
    if (err.response?.errors) {
        console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2));
    }
    // Provide a more specific error message to the client if possible
    res.status(500).json({ error: "Mint process failed.", details: err.message });
  }
});

// --- Other Endpoints (Balances, Supply) - Unchanged ---

// Get balances for a specific wallet
app.get("/balances/:wallet", async (req, res) => {
  const { wallet } = req.params; // Expecting CAIP-10 address format from frontend if possible
  if (!wallet) {
      return res.status(400).json({ error: "Wallet address required." });
  }

  const query = gql`
    query GetTokensByOwner($collectionId: BigInt!, $wallet: String!) {
      TokensByOwner(collectionId: $collectionId, address: $wallet) {
        tokenId
        balance # Balance is usually a string, needs parsing
      }
    }
  `;

  try {
    const data = await request({
      url: PLATFORM_URL,
      document: query,
      variables: { collectionId: COLLECTION_ID, wallet },
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    const balances = {};
    // Ensure TokensByOwner is an array before iterating
    if (data?.TokensByOwner && Array.isArray(data.TokensByOwner)) {
        data.TokensByOwner.forEach(({ tokenId, balance }) => {
            // Only include balances for the tokens we care about (1, 2, 3)
            if (TOKEN_IDS.includes(parseInt(tokenId, 10))) {
                 balances[tokenId] = parseInt(balance, 10);
            }
        });
    } else {
         console.warn(`No TokensByOwner data found for wallet ${wallet}`);
    }


    res.json(balances);
  } catch (err) {
    console.error("Balance fetch error:", err.response?.errors || err.message);
    res.status(500).json({ error: "Could not get balances", details: err.message });
  }
});

// Returns remaining supply (simplified)
app.get("/supply", async (req, res) => {
  // This query might need adjustment based on exact schema to get total supply accurately
  // It might be better to query each token ID (1, 2, 3) and sum their supplies
  const query = gql`
    query GetCollectionTokens($collectionId: BigInt!) {
      Tokens(collectionId: $collectionId, filter: { tokenId_in: ["1", "2", "3"] }) {
         tokenId
         totalSupply
      }
    }
  `;
  const MAX_SUPPLY_PER_TOKEN = 50; // Assuming 50 for each of Rock, Paper, Scissors
  const TOTAL_POSSIBLE = MAX_SUPPLY_PER_TOKEN * TOKEN_IDS.length; // 150

  try {
    const data = await request({
      url: PLATFORM_URL,
      document: query,
      variables: { collectionId: COLLECTION_ID },
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    let totalMinted = 0;
    if (data?.Tokens && Array.isArray(data.Tokens)) {
        totalMinted = data.Tokens.reduce((sum, t) => sum + parseInt(t.totalSupply || '0', 10), 0);
    } else {
        console.warn("Could not accurately determine total minted supply from Tokens query.");
    }

    const remaining = TOTAL_POSSIBLE - totalMinted;

    res.json({ remaining: Math.max(0, remaining) }); // Ensure remaining isn't negative

  } catch (err) {
    console.error("Supply error:", err.response?.errors || err.message);
    res.status(500).json({ error: "Could not fetch supply", details: err.message });
  }
});

// Basic root route (optional)
app.get("/", (req, res) => {
    res.send("RPS Minting Backend is running.");
});
