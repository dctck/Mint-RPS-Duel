require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { request, gql } = require("graphql-request");

const app = express();
const PORT = 5000;

app.use(cors());
app.use(bodyParser.json());

const PLATFORM_URL = process.env.PLATFORM_URL;
const AUTH_TOKEN = process.env.ENJIN_API_TOKEN;
const COLLECTION_ID = parseInt(process.env.COLLECTION_ID);
const RECEIVER_WALLET = process.env.RECEIVER_WALLET;

const TOKEN_IDS = [1, 2, 3];
const TOKEN_NAMES = { 1: "Rock", 2: "Paper", 3: "Scissors" };

// Step 1: Start an auth session (user scans QR)
app.get("/start-auth", async (req, res) => {
  const mutation = gql`
    mutation {
      CreateAuthToken {
        id
        qr
        expiresIn
      }
    }
  `;

  try {
    const data = await request({
      url: PLATFORM_URL,
      document: mutation,
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    res.json(data.CreateAuthToken);
  } catch (err) {
    console.error("Auth error:", err);
    res.status(500).json({ error: "Auth failed" });
  }
});

// Step 2: Mint after user scans QR and approves payment
app.post("/mint", async (req, res) => {
  const { authTokenId } = req.body;

  try {
    // Fetch wallet address
    const query = gql`
      query($id: String!) {
        AuthToken(id: $id) {
          wallet {
            id
          }
        }
      }
    `;

    const { AuthToken } = await request({
      url: PLATFORM_URL,
      document: query,
      variables: { id: authTokenId },
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    const userWallet = AuthToken.wallet.id;

    // Step 2.1: Random available token (simplified, assumes all are available)
    const randomTokenId = TOKEN_IDS[Math.floor(Math.random() * TOKEN_IDS.length)];

    // Step 2.2: Charge 10 ENJ
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
        value: "10000000000000000000", // 10 ENJ in Witoshi
        authTokenId,
      },
    };

    await request({
      url: PLATFORM_URL,
      document: txMutation,
      variables: txVars,
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    // Step 2.3: Mint token
    const mintMutation = gql`
      mutation MintToken($collectionId: BigInt!, $tokenId: EncodableTokenIdInput!, $recipient: String!, $amount: BigInt!) {
        MintToken(collectionId: $collectionId, tokenId: $tokenId, recipient: $recipient, amount: $amount) {
          id
          state
        }
      }
    `;

    await request({
      url: PLATFORM_URL,
      document: mintMutation,
      variables: {
        collectionId: COLLECTION_ID,
        tokenId: { integer: randomTokenId },
        recipient: userWallet,
        amount: 1,
      },
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    res.json({
      success: true,
      tokenId: randomTokenId,
      tokenName: TOKEN_NAMES[randomTokenId],
    });
  } catch (err) {
    console.error("Mint error:", err);
    res.status(500).json({ error: "Mint failed" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

//Get check auth

app.get("/check-auth/:authTokenId", async (req, res) => {
  const { authTokenId } = req.params;

  const query = gql`
    query($id: String!) {
      AuthToken(id: $id) {
        wallet {
          id
        }
      }
    }
  `;

  try {
    const { AuthToken } = await request({
      url: PLATFORM_URL,
      document: query,
      variables: { id: authTokenId },
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    if (AuthToken?.wallet?.id) {
      res.json({ address: AuthToken.wallet.id });
    } else {
      res.json({ address: null });
    }
  } catch (err) {
    console.error("Check auth error:", err);
    res.status(500).json({ error: "Failed to check auth" });
  }
});

//get balance from wallet

app.get("/balances/:wallet", async (req, res) => {
  const { wallet } = req.params;

  const query = gql`
    query($collectionId: BigInt!, $wallet: String!) {
      TokensByOwner(collectionId: $collectionId, address: $wallet) {
        tokenId
        balance
      }
    }
  `;

  try {
    const { TokensByOwner } = await request({
      url: PLATFORM_URL,
      document: query,
      variables: { collectionId: COLLECTION_ID, wallet },
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    const balances = {};
    TokensByOwner.forEach(({ tokenId, balance }) => {
      balances[tokenId] = parseInt(balance, 10);
    });

    res.json(balances);
  } catch (err) {
    console.error("Balance fetch error:", err);
    res.status(500).json({ error: "Could not get balances" });
  }
});

// returns supply of each NFT

app.get("/supply", async (req, res) => {
  const query = gql`
    query($collectionId: BigInt!) {
      Tokens(collectionId: $collectionId) {
        totalSupply
      }
    }
  `;

  try {
    const { Tokens } = await request({
      url: PLATFORM_URL,
      document: query,
      variables: { collectionId: COLLECTION_ID },
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    const totalMinted = Tokens.reduce((sum, t) => sum + parseInt(t.totalSupply, 10), 0);
    const remaining = 150 - totalMinted;

    res.json({ remaining });
  } catch (err) {
    console.error("Supply error:", err);
    res.status(500).json({ error: "Could not fetch supply" });
  }
});
