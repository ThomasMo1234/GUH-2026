import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { post } from "../api";

export default function Home() {
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");

  const create = async () => {
    try {
      const { id } = await post<{ id: string }>("/api/lectures");
      nav(`/lecturer/${id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="wrap">
      <div className="hero">
        <div className="logo" style={{ justifyContent: "center", marginBottom: 18 }}>
          <i /> Signal
        </div>
        <h1>Find the moment the room got lost.</h1>
        <p>Students bookmark confusing moments with one tap. Lecturers see exactly when it happened. Everyone gets caught up afterwards.</p>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="two">
        <div className="card">
          <h2>I'm lecturing</h2>
          <p className="sub">Start a session, show the QR code, and watch the heatmap fill in.</p>
          <button className="btn primary" onClick={create}>
            Start a lecture
          </button>
        </div>
        <div className="card">
          <h2>I'm a student</h2>
          <p className="sub">Enter the 4-letter code on the lecturer's screen (or just scan their QR code).</p>
          <div className="row">
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD" maxLength={4} style={{ width: 120, textTransform: "uppercase" }} />
            <button className="btn primary" disabled={code.length < 4} onClick={() => nav(`/join/${code}`)}>
              Join
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
