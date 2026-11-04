import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";
import { Backdrop, Title, green, enter } from "./Common";
export const Outro: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Backdrop>
      <div
        style={{
          position: "absolute",
          left: 140,
          top: 215,
          width: 1640,
          textAlign: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 30,
            marginBottom: 36,
            opacity: enter(f, 4),
          }}
        >
          <Img
            src={staticFile("logo.png")}
            style={{ width: 114, height: 114 }}
          />
          <div style={{ fontSize: 112, fontWeight: 650, letterSpacing: -4 }}>
            Pilion
          </div>
        </div>
        <Title delay={14} size={91}>
          你自己的浏览器。你自己的 Agent。
        </Title>
        <div
          style={{
            display: "inline-block",
            marginTop: 48,
            padding: "18px 45px",
            borderRadius: 50,
            color: "#0b2818",
            background: green,
            fontSize: 36,
            fontWeight: 600,
            opacity: enter(f, 32),
          }}
        >
          开始你的第一个任务 ↗
        </div>
        <div
          style={{
            fontSize: 39,
            color: "#b6cdbf",
            marginTop: 35,
            letterSpacing: 1,
          }}
        >
          pilion.echovic.com
        </div>
        <div style={{ fontSize: 24, color: "#6e9780", marginTop: 22 }}>
          免费开源 · v0.2.0 · macOS / Windows / Linux
        </div>
      </div>
    </Backdrop>
  );
};
