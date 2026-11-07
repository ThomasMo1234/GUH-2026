import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import Lecturer from "./pages/Lecturer";
import Student from "./pages/Student";
import Digest from "./pages/Digest";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/lecturer/:id" element={<Lecturer />} />
        <Route path="/join/:id" element={<Student />} />
        <Route path="/digest/:id" element={<Digest />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
