import { useState } from "react";
import { useAuth } from "../context/AuthContext";

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!username || !password) {
      setError("Enter your username and password.");
      return;
    }
    setSubmitting(true);
    try {
      await login(username, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--navy-dark)" }}>
      <div style={{ width: "100%", maxWidth: 380, background: "#fff", borderRadius: 12, boxShadow: "0 10px 40px rgba(0,0,0,0.35)", overflow: "hidden" }}>
        <div style={{ background: "var(--navy)", padding: "26px 28px 20px", borderBottom: "4px solid var(--gold)", textAlign: "center" }}>
          <div style={{ width: 52, height: 52, borderRadius: 8, background: "var(--gold)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--navy-dark)", fontSize: 26, fontWeight: "bold", margin: "0 auto 12px" }}>!</div>
          <div style={{ fontSize: 11, letterSpacing: 2, color: "var(--gold)", fontWeight: "bold", textTransform: "uppercase" }}>CSOMS</div>
          <h1 style={{ color: "#fff", fontSize: 20, marginTop: 4 }}>Central Security Operations Management System</h1>
          <div style={{ fontSize: 12, color: "#C9D3E3", marginTop: 4 }}>Brookside Farms Corporation</div>
        </div>
        <form onSubmit={handleSubmit} style={{ padding: "26px 28px" }}>
          <div className="form-field" style={{ marginBottom: 14 }}>
            <label>Username</label>
            <input type="text" style={{ width: "100%" }} autoComplete="username"
              value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="form-field" style={{ marginBottom: 6 }}>
            <label>Password</label>
            <input type="password" style={{ width: "100%" }} autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div style={{ color: "var(--red)", fontSize: 12.5, minHeight: 18, margin: "6px 0 10px" }}>{error}</div>
          <button type="submit" className="btn btn-gold" style={{ width: "100%", justifyContent: "center" }} disabled={submitting}>
            {submitting ? "Logging in..." : "Log in"}
          </button>
        </form>
      </div>
    </div>
  );
}
