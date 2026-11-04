import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
export const green = "#79ecb4";
export const ease = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;
export const enter = (frame: number, delay = 0) =>
  spring({
    frame: frame - delay,
    fps: 30,
    config: { damping: 24, stiffness: 100, mass: 1 },
  });
export const Label: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div
    style={{
      fontSize: 24,
      letterSpacing: 4,
      color: green,
      fontWeight: 600,
      marginBottom: 22,
      textTransform: "uppercase",
    }}
  >
    {children}
  </div>
);
export const Backdrop: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        background: "#0b1110",
        color: "#f2f6f3",
        fontFamily: "PilionCN, sans-serif",
        overflow: "hidden",
      }}
    >
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at ${72 + Math.sin(f / 100) * 4}% 38%, #173d2c88, transparent 65%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(#b7ffdb05 1px,transparent 1px),linear-gradient(90deg,#b7ffdb05 1px,transparent 1px)",
          backgroundSize: "80px 80px",
          maskImage: "linear-gradient(transparent,#000,transparent)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 54,
          left: 82,
          display: "flex",
          alignItems: "center",
          gap: 14,
          opacity: 0.85,
        }}
      >
        <Img src={staticFile("logo.png")} style={{ width: 38, height: 38 }} />
        <span style={{ fontSize: 26, fontWeight: 600 }}>Pilion</span>
      </div>
      {children}
    </AbsoluteFill>
  );
};
export const Title: React.FC<{
  children: React.ReactNode;
  delay?: number;
  size?: number;
}> = ({ children, delay = 0, size = 100 }) => {
  const f = useCurrentFrame();
  const p = enter(f, delay);
  return (
    <div
      style={{
        fontSize: size,
        fontWeight: 650,
        lineHeight: 1.22,
        letterSpacing: -3,
        opacity: p,
        transform: `translateY(${(1 - p) * 35}px)`,
      }}
    >
      {children}
    </div>
  );
};
export const Hint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{ fontSize: 34, color: "#98b5a7", lineHeight: 1.5, marginTop: 25 }}
  >
    {children}
  </div>
);
export const Screenshot: React.FC<{
  file: string;
  width?: number;
  left?: number;
  top?: number;
  rotate?: number;
}> = ({ file, width = 1200, left = 640, top = 225, rotate = 0 }) => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const p = enter(f, 12);
  const z = interpolate(f, [0, durationInFrames], [1, 1.035], ease);
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width,
        transform: `translateY(${(1 - p) * 70}px) scale(${z}) rotate(${rotate}deg)`,
        transformOrigin: "top left",
        opacity: p,
        borderRadius: 18,
        overflow: "hidden",
        border: "1px solid #86c8a43b",
        boxShadow: "0 32px 100px #000b",
      }}
    >
      <div
        style={{
          background: "#15251c",
          height: 36,
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingLeft: 16,
        }}
      >
        {["#e5a88c", "#e2cb85", "#84ca9d"].map((c) => (
          <span
            key={c}
            style={{
              width: 9,
              height: 9,
              borderRadius: 9,
              background: c,
              opacity: 0.6,
            }}
          />
        ))}
        <span style={{ color: "#91ac9a", fontSize: 16, marginLeft: 12 }}>
          Pilion · 真实产品界面
        </span>
      </div>
      <Img
        src={staticFile(`images/${file}`)}
        style={{ width: "100%", display: "block" }}
      />
    </div>
  );
};
