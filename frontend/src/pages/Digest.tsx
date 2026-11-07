import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, DigestItem, studentId } from "../api";

export default function Digest() {
  const { id = "" } = useParams();
  const [items, setItems] = useState<DigestItem[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api<{ items: DigestItem[] }>(`/api/lectures/${id}/digest?student_id=${studentId()}`)
      .then((r) => setItems(r.items))
      .catch((e) => setErr((e as Error).message));
  }, [id]);

  return (
    <div className="wrap narrow">
      <div className="top">
        <div className="logo"><i /> Signal</div>
        <span className="chip">Lecture {id}</span>
      </div>
      <h2 style={{ fontSize: 24, marginBottom: 6 }}>Your catch-up notes</h2>
      <p className="sub">One short explanation for each moment you bookmarked.</p>

      {err && <div className="err">{err}</div>}
      {!items && !err && (
        <>
          <p className="sub">Writing your explanations…</p>
          <div className="skeleton" />
          <div className="skeleton" />
        </>
      )}
      {items && items.length === 0 && <div className="card"><p className="sub" style={{ margin: 0 }}>You didn't bookmark anything, so you were with the lecturer the whole way. Nice.</p></div>}
      {items?.map((it, i) => (
        <div className="card dcard" key={i}>
          <span className="chip">{it.label} into the lecture</span>
          <h3>{it.title}</h3>
          <p className="said">{it.said}</p>
          <div className="blk"><b>Explained simply</b>{it.explanation}</div>
          {it.example && <div className="blk"><b>Example</b>{it.example}</div>}
          {it.check_yourself && <div className="blk"><b>Check yourself</b>{it.check_yourself}</div>}
        </div>
      ))}
    </div>
  );
}
