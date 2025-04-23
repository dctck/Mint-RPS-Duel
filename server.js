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
  // Removed expiresIn field from the query as it's not available
  const query = gql`
    query RequestAccount {
      RequestAccount {
        qrCode          # URL pointing to the QR code image
        verificationId  # ID to use for polling verification status
        # expiresIn was removed as it's not in the schema type
      }
    }
  `;

  try {
    console.log("Requesting account verification from Enjin Platform...");
    const data = await request({
      url: PLATFORM_URL,
      document: query,
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    const verificationData = data?.RequestAccount;

    // Check for required fields (ID, QR)
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
     } else if (err.response?.error) {
         console.error("Raw API Error Response:", err.response.error);
     }
    res.status(500).json({ error: "Verification request failed", details: err.message });
  }
});

// Step 2: Check Authentication Status (Polling) using GetAccountVerified query
app.get("/check-auth/:verificationId", async (req, res) => {
    const { verificationId } = req.params;
    if (!verificationId) {
        return res.status(400).json({ error: "Verification ID is required" });
    }

    // Added balances { free } to the query
    const query = gql`
      query GetAccountVerified($verificationId: String!) {
        GetAccountVerified(verificationId: $verificationId) {
          verified
          account {
            address # CAIP-10 address format
            balances { # Added balances field
                free # Free ENJ balance in Witoshi (String)
            }
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
      const enjBalanceWitoshi = verificationStatus?.account?.balances?.free ?? null;

      console.log(`Polling verification ${verificationId}: Verified=${isVerified}, Wallet=${walletAddress || 'N/A'}, Balance=${enjBalanceWitoshi ?? 'N/A'}`);

      if (isVerified && walletAddress) {
        res.json({
            address: walletAddress,
            balance: enjBalanceWitoshi
        });
      } else {
        res.json({ address: null, balance: null }); // Not verified yet
      }
    } catch (err) {
      if (err.response?.errors) {
          console.error("Check verification GraphQL error:", err.response.errors);
          if (err.response.errors.some(e => e.message.includes("not found"))) {
             return res.status(404).json({ address: null, balance: null, error: "Verification ID not found or expired." });
          }
      } else {
          console.error("Check verification network/request error:", err.message);
      }
      res.status(200).json({ address: null, balance: null, error: "Failed to check verification status." });
    }
});


// Step 3: Mint endpoint REMOVED

// --- Other Endpoints (Balances, Supply) - Kept for potential use ---
app.get("/balances/:wallet", async (req, res) => {
    const { wallet } = req.params;
    if (!wallet) { return res.status(400).json({ error: "Wallet address required." }); }
    const query = gql` query GetTokensByOwner($collectionId: BigInt!, $wallet: String!) { TokensByOwner(collectionId: $collectionId, address: $wallet) { tokenId balance } } `;
    const COLLECTION_ID = parseInt(process.env.COLLECTION_ID || '0');
    const TOKEN_IDS = [1, 2, 3];
    try {
        const data = await request({ url: PLATFORM_URL, document: query, variables: { collectionId: COLLECTION_ID, wallet }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
        const balances = {};
        if (data?.TokensByOwner && Array.isArray(data.TokensByOwner)) {
            data.TokensByOwner.forEach(({ tokenId, balance }) => {
                if (TOKEN_IDS.includes(parseInt(tokenId, 10))) { balances[tokenId] = parseInt(balance, 10); }
            });
        } else { console.warn(`No TokensByOwner data found for wallet ${wallet}`); }
        res.json(balances);
    } catch (err) { console.error("Balance fetch error:", err.response?.errors || err.message); res.status(500).json({ error: "Could not get balances", details: err.message }); }
});

app.get("/supply", async (req, res) => {
    const query = gql` query GetCollectionTokens($collectionId: BigInt!) { Tokens(collectionId: $collectionId, filter: { tokenId_in: ["1", "2", "3"] }) { tokenId totalSupply } } `;
    const COLLECTION_ID = parseInt(process.env.COLLECTION_ID || '0');
    const TOKEN_IDS = [1, 2, 3];
    const MAX_SUPPLY_PER_TOKEN = 50;
    const TOTAL_POSSIBLE = MAX_SUPPLY_PER_TOKEN * TOKEN_IDS.length;
    try {
        const data = await request({ url: PLATFORM_URL, document: query, variables: { collectionId: COLLECTION_ID }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
        let totalMinted = 0;
        if (data?.Tokens && Array.isArray(data.Tokens)) { totalMinted = data.Tokens.reduce((sum, t) => sum + parseInt(t.totalSupply || '0', 10), 0); }
        else { console.warn("Could not accurately determine total minted supply from Tokens query."); }
        const remaining = TOTAL_POSSIBLE - totalMinted;
        res.json({ remaining: Math.max(0, remaining) });
    } catch (err) { console.error("Supply error:", err.response?.errors || err.message); res.status(500).json({ error: "Could not fetch supply", details: err.message }); }
});

// Basic root route (optional)
app.get("/", (req, res) => {
    res.send("RPS Auth Backend is running.");
});
