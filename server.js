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
// Minting constants are removed as the /mint endpoint is not used

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
    // Fetch internal wallet ID (id) along with other details
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


// --- Other Endpoints (Balances, Supply) ---

// Get FT balances for a specific wallet - UPDATED to query by account address
app.get("/balances/:walletAddress", async (req, res) => {
  const { walletAddress } = req.params; // Use the public CAIP-10 address

  if (!walletAddress) {
    return res.status(400).json({ error: "Wallet address required." });
  }

  const COLLECTION_ID = parseInt(process.env.COLLECTION_ID || '0');
  const TOKEN_IDS_TO_CHECK = [1, 2, 3];

  // Using GetWallet query with 'account' argument as confirmed by Enjin dev
  const query = gql`
    query GetWalletTokenBalances($account: String!, $collectionId: BigInt!, $tokenIds: [BigInt!]) {
      GetWallet(account: $account) { # Use account (address string)
        tokenAccounts(
          collectionIds: [$collectionId]
          tokenIds: $tokenIds
        ) {
          edges {
            node {
              token {
                tokenId
              }
              balance
            }
          }
        }
      }
    }
  `;

  const variables = {
    account: walletAddress, // Pass the address string
    collectionId: COLLECTION_ID,
    tokenIds: TOKEN_IDS_TO_CHECK,
  };

  try {
    console.log(`Fetching FT balances for wallet address: ${walletAddress}, collection: ${COLLECTION_ID}`);
    const data = await request({
      url: PLATFORM_URL,
      document: query,
      variables,
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    const balances = { "1": 0, "2": 0, "3": 0 };
    const edges = data?.GetWallet?.tokenAccounts?.edges;

    if (edges && Array.isArray(edges)) {
      edges.forEach(edge => {
        const node = edge?.node;
        if (node && node.token && node.token.tokenId && node.balance) {
          const tokenIdStr = node.token.tokenId.toString();
          if (balances.hasOwnProperty(tokenIdStr)) {
            balances[tokenIdStr] = parseInt(node.balance, 10);
          }
        }
      });
    } else {
      console.warn(`No tokenAccounts found for wallet address ${walletAddress}.`);
    }

    console.log("FT Balances:", balances);
    res.json(balances);

  } catch (err) {
    console.error("Balance fetch error:", err.response?.errors || err.message);
    if (err.response?.errors) { console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2)); }
    res.status(500).json({ error: "Could not get balances", details: err.message });
  }
});


// Get supply - UPDATED to use 'id' argument for GetCollection
app.get("/supply", async (req, res) => {
    // Using GetCollection query with 'id' argument
    const query = gql`
        query GetTotalFungibleSupply($collectionId: BigInt!) {
            GetCollection(id: $collectionId) { # Use 'id' argument
                tokens(first: 100) {
                    edges {
                        node {
                            tokenId
                            supply
                            capSupply
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
        let totalMaxSupply = 0;
        const edges = data?.GetCollection?.tokens?.edges;
        if (edges && Array.isArray(edges)) {
            edges.forEach(edge => {
                const node = edge?.node;
                if (node && node.tokenId && node.supply && TOKEN_IDS_TO_CHECK.includes(node.tokenId.toString())) {
                    totalMinted += parseInt(node.supply || '0', 10);
                    totalMaxSupply += parseInt(node.capSupply || '0', 10);
                }
            });
        } else {
            console.warn("Could not accurately determine total minted supply from GetCollection query.");
            totalMaxSupply = 150; // Fallback if needed
        }

        const remaining = totalMaxSupply - totalMinted;
        console.log(`Total minted (IDs ${TOKEN_IDS_TO_CHECK.join(', ')}): ${totalMinted}, Remaining: ${remaining}`);
        res.json({
            totalMinted,
            totalMaxSupply,
            remaining: Math.max(0, remaining)
        });

    } catch (err) {
        console.error("Supply error:", err.response?.errors || err.message);
        if (err.response?.errors) { console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2)); }
        res.status(500).json({ error: "Could not get supply", details: err.message });
    }
});

// Basic root route (optional)
app.get("/", (req, res) => {
    res.send("RPS Auth Backend is running.");
});
