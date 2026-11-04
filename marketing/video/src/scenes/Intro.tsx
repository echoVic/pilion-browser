import React from "react";
import { Img, staticFile, useCurrentFrame, interpolate } from "remotion";
import { Backdrop, Title, Hint, enter, green, ease } from "./Common";
export const Intro: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Backdrop>
      {["调研", "表单", "报告", "搜索"].map((t, i) => {
        const p = enter(f, 42 + i * 4);
        return (
          <div
            key={t}
            style={{
              position: "absolute",
              left: 240 + i * 385,
              top: 180 + Math.sin(i) * 65,
              opacity: interpolate(f, [0, 35, 60, 75], [0, 0.5, 0.5, 0], ease),
              transform: `translate(${(930 - 240 - i * 385) * p}px,${(280 - 180 - Math.sin(i) * 65) * p}px) rotate(${(i - 1.5) * 6 * (1 - p)}deg)`,
              padding: "18px 55px",
              border: "1px solid #779e8740",
              borderRadius: 14,
              background: "#16231c",
              fontSize: 28,
            }}
          >
            {t}
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 110,
          top: 235,
          width: 1700,
          textAlign: "center",
        }}
      >
        <Img
          src={staticFile("logo.png")}
          style={{
            width: 150,
            height: 150,
            marginBottom: 45,
            opacity: enter(f, 40),
            transform: `scale(${0.6 + enter(f, 40) * 0.4})`,
            boxShadow: "0 12px 65px #19473b",
          }}
        />
        <Title delay={58} size={118}>
          你自己的 Agent。
          <br />
          <span style={{ color: green }}>用上你的浏览器。</span>
        </Title>
        <Hint>让 AI 的能力，进入你的日常</Hint>
      </div>
    </Backdrop>
  );
};
