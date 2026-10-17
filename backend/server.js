const express = require("express");
const authRouter = require("./auth");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    "http://localhost:5500",
    "http://127.0.0.1:5500"
  ]
}));
app.use(express.json());

//Basic backend health check
app.get("/", (req, res) => {
  res.send("ScopeDesk backend is running!");
});

//Authentication API routes
app.use("/api/auth",authRouter);
const authMiddleware = require("./authMiddleware");

app.get("/api/protected", authMiddleware, (req, res) => {
  res.json({
    message: "Authentication successful!",
    user: req.user
  });
});

app.listen(PORT, () => {
  console.log(`ScopeDesk backend running at http://localhost:${PORT}`);
});