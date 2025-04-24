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
const AUTH_TOKEN = process.env.ENJIN_API_TOKEN;
// Removed unused constants

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
    const query = gql`
      query GetVerifiedWallet($verificationId: String!) {
        GetWallet(verificationId: $verificationId) {
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
      console.log(`Polling verification ${verificationId}: WalletData=${walletData ? 'Found' : 'Null'}, Address=${walletAddress || 'N/A'}, Balance=${enjBalanceWitoshi ?? 'N/A'}`);
      if (walletData && walletAddress) { res.json({ address: walletAddress, balance: enjBalanceWitoshi }); }
      else { res.json({ address: null, balance: null }); }
    } catch (err) { if (err.response?.errors) { console.error("Check verification GraphQL error:", err.response.errors); } else { console.error("Check verification network/request error:", err.message); } res.status(200).json({ address: null, balance: null, error: "Failed to check verification status or not yet verified." }); }
});

// --- Other Endpoints (Balances, Supply) ---

// Get FT balances for a specific wallet - Using GetWallet query
app.get("/balances/:wallet", async (req, res) => {
    const { wallet } = req.params; // This is the CAIP-10 wallet address
    if (!wallet) { return res.status(400).json({ error: "Wallet address required." }); }

    const COLLECTION_ID = parseInt(process.env.COLLECTION_ID || '0');
    const TOKEN_IDS_TO_CHECK = [1, 2, 3]; // Specific tokens we care about

    // Using GetWallet query and requesting tokenAccounts connection within it
    // Assuming GetWallet works with address for fetching balances.
    const query = gql`
        query GetFungibleTokenBalances($walletAddress: String!, $collectionId: BigInt!, $tokenIds: [BigInt!]) {
            # Attempting to query GetWallet using address - VERIFY IF THIS IS SUPPORTED
            GetWallet(address: $walletAddress) {
                tokenAccounts(
                    collectionIds: [$collectionId]
                    tokenIds: $tokenIds
                    first: 10
                 ) {
                    edges {
                        node {
                            tokenId
                            balance
                        }
                    }
                }
            }
        }
    `;

    try {
        console.log(`Fetching FT balances for wallet: ${wallet}, collection: ${COLLECTION_ID}, tokens: ${TOKEN_IDS_TO_CHECK}`);
        const variables = {
            walletAddress: wallet, // Pass the address
            collectionId: COLLECTION_ID,
            tokenIds: TOKEN_IDS_TO_CHECK
        };
        const data = await request({ url: PLATFORM_URL, document: query, variables: variables, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });

        const balances = { "1": 0, "2": 0, "3": 0 }; // Initialize with 0 counts

        const edges = data?.GetWallet?.tokenAccounts?.edges;
        if (edges && Array.isArray(edges)) {
            edges.forEach(edge => {
                const node = edge?.node;
                if (node && node.tokenId && node.balance) {
                    const tokenIdStr = node.tokenId.toString();
                    if (balances.hasOwnProperty(tokenIdStr)) {
                        balances[tokenIdStr] = parseInt(node.balance, 10);
                    }
                }
            });
        } else {
            console.warn(`No tokenAccounts edges found for wallet ${wallet} and collection ${COLLECTION_ID} via GetWallet query.`);
        }

        console.log(`NFT Balances found:`, balances);
        res.json(balances);

    } catch (err) {
        console.error("Balance fetch error:", err.response?.errors || err.message);
        if (err.response?.errors) { console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2)); }
        res.status(500).json({ error: "Could not get balances", details: err.message });
    }
});


// Get supply - UPDATED QUERY using Collection type and 'supply' field
app.get("/supply", async (req, res) => {
    // Using Collection query based on AI Assistant suggestion
    const query = gql`
        query GetTotalFungibleSupply($collectionId: BigInt!) {
            Collection(id: $collectionId) {
                tokens(first: 100) { # Request first 100 tokens
                    edges {
                        node {
                            tokenId
                            supply # Use 'supply' field based on AI Assistant example
                            # type # Optional type field
                        }
                    }
                }
            }
        }
    `;
    const COLLECTION_ID = parseInt(process.env.COLLECTION_ID || '0');
    const TOKEN_IDS_TO_CHECK = ["1", "2", "3"]; // Use strings for comparison later
    const MAX_SUPPLY_PER_TOKEN = 50;
    const TOTAL_POSSIBLE = MAX_SUPPLY_PER_TOKEN * TOKEN_IDS_TO_CHECK.length; // 150

    try {
        console.log(`Fetching token supply for collection: ${COLLECTION_ID}`);
        const data = await request({ url: PLATFORM_URL, document: query, variables: { collectionId: COLLECTION_ID }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });

        let totalMinted = 0;
        // Process edges from the tokens connection
        const edges = data?.Collection?.tokens?.edges;
        if (edges && Array.isArray(edges)) {
            edges.forEach(edge => {
                const node = edge?.node;
                // Check if node exists and has the fields, and if it's one of the tokens we care about
                // Use 'supply' field now
                if (node && node.tokenId && node.supply && TOKEN_IDS_TO_CHECK.includes(node.tokenId.toString())) {
                    totalMinted += parseInt(node.supply || '0', 10);
                }
            });
        } else {
            console.warn("Could not accurately determine total minted supply from Collection query.");
        }

        const remaining = TOTAL_POSSIBLE - totalMinted;
        console.log(`Total minted (IDs ${TOKEN_IDS_TO_CHECK.join(', ')}): ${totalMinted}, Remaining: ${remaining}`);
        res.json({ remaining: Math.max(0, remaining) }); // Ensure remaining isn't negative

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
