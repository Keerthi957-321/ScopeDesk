const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("./db");
const jwt = require("jsonwebtoken");
const router = express.Router();

// Health check for the authentication API
router.get("/", (req, res) => {
  res.json({
    message: "ScopeDesk authentication API is running!"
  });
});

// Signup validation (MySQL storage will be added later)
router.post("/signup", async (req, res) => {
  try {
    const { username, email, password, role,organization } = req.body;
    

    if (
  typeof username !== "string" ||
  typeof email !== "string" ||
  typeof password !== "string" ||
  typeof role !== "string"
) {
  return res.status(400).json({
    message: "Username, email, password, and role are required."
  });
}

    const cleanUsername = username.trim();

    if (cleanUsername.length < 3 || cleanUsername.length > 50) {
      return res.status(400).json({
        message: "Username must be between 3 and 50 characters."
      });
    }

    if (!["client", "vendor"].includes(role)) {
      return res.status(400).json({
        message: "Role must be client or vendor."
      });
    }

    if (
      password.length < 8 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      return res.status(400).json({
        message: "Password must be at least 8 characters and no more than 72 bytes."
      });
    }

    // Hash the password before storing it in the database.
    const passwordHash = await bcrypt.hash(password, 12);

    const cleanEmail = email.trim().toLowerCase();

if (
  cleanEmail.length > 255 ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
) {
  return res.status(400).json({
    message: "Please enter a valid email address."
  });
}

const cleanOrganization =
  typeof organization === "string" && organization.trim()
    ? organization.trim()
    : null;

if (cleanOrganization && cleanOrganization.length > 150) {
  return res.status(400).json({
    message: "Organization must be 150 characters or fewer."
  });
}

const [result] = await db.execute(
  "CALL sp_register_user(?, ?, ?, ?, ?)",
  [
    cleanUsername,
    cleanEmail,
    passwordHash,
    role,
    cleanOrganization
  ]
);

const userId = result?.[0]?.[0]?.user_id;

return res.status(201).json({
  message: "Account created successfully.",
  user: {
    id: userId,
    username: cleanUsername,
    email: cleanEmail,
    role
  }
});
  } catch (error) {
    console.error("Signup error:", error.message);
    return res.status(500).json({
      message: "An unexpected error occurred."
    });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      !username.trim() ||
      !password
    ) {
      return res.status(400).json({
        message: "Username and password are required."
      });
    }

    const [rows] = await db.execute(
      `SELECT user_id, username, email, password_hash, role,
              organization, is_active
       FROM users
       WHERE username = ?
       LIMIT 1`,
      [username.trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        message: "Invalid username or password."
      });
    }

    const user = rows[0];

    if (!user.is_active) {
      return res.status(403).json({
        message: "This account is inactive. Contact your administrator."
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        message: "Invalid username or password."
      });
    }

    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is not configured.");
    }

    const token = jwt.sign(
      {
        userId: user.user_id,
        username: user.username,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    return res.json({
      message: "Login successful.",
      token,
      user: {
        id: user.user_id,
        username: user.username,
        email: user.email,
        role: user.role,
        organization: user.organization
      }
    });
  } catch (error) {
    console.error("Login error:", error.message);
    return res.status(500).json({
      message: "An unexpected error occurred during login."
    });
  }
});

module.exports = router;
