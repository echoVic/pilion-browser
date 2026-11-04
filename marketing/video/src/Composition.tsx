import React from "react";
import {
  AbsoluteFill,
  Composition,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import manifest from "../public/audio/manifest.json";
import { Intro } from "./scenes/Intro";
import { Direct } from "./scenes/Direct";
import { Spaces } from "./scenes/Spaces";
import { Control } from "./scenes/Control";
import { Product } from "./scenes/Product";
import { Outro } from "./scenes/Outro";
import "./style.css";
const scenes = [Intro, Direct, Spaces, Control, Product, Outro];
const FPS = 30,
  DURATION = 1860,
  TRANSITION = 18;
const Captions: React.FC = () => {
  const f = useCurrentFrame();
  const t = f / FPS;
  let text = "";
  for (const scene of manifest.scenes) {
    for (const cue of scene.subtitles) {
      const start = scene.start + scene.audioOffset + cue.start;
      const end = scene.start + scene.audioOffset + cue.end;
      if (t >= start && t < end) text = cue.text;
    }
  }
  return text ? (
    <div
      style={{
        position: "absolute",
        bottom: 58,
        left: 110,
        right: 110,
        display: "flex",
        justifyContent: "center",
        fontFamily: "PilionCN,sans-serif",
      }}
    >
      <div
        style={{
          fontSize: 32,
          color: "#fff",
          padding: "12px 28px",
          background: "#07100ceb",
          border: "1px solid #6f9b8150",
          borderRadius: 12,
          lineHeight: 1.45,
          maxWidth: 1550,
          textAlign: "center",
        }}
      >
        {text}
      </div>
    </div>
  ) : null;
};
export const Promo: React.FC = () => {
  return (
    <AbsoluteFill>
      <TransitionSeries>
        {manifest.scenes.map((s, i) => {
          const Scene = scenes[i];
          return (
            <React.Fragment key={s.id}>
              <TransitionSeries.Sequence
                durationInFrames={
                  s.sceneDurationFrames + (i < 5 ? TRANSITION : 0)
                }
              >
                <Scene />
              </TransitionSeries.Sequence>
              {i < 5 ? (
                <TransitionSeries.Transition
                  presentation={fade()}
                  timing={linearTiming({ durationInFrames: TRANSITION })}
                />
              ) : null}
            </React.Fragment>
          );
        })}
      </TransitionSeries>
      <Audio src={staticFile("audio/mix.m4a")} />
      <Captions />
    </AbsoluteFill>
  );
};
export const MyComposition: React.FC = () => (
  <Composition
    id="PilionPromo"
    component={Promo}
    durationInFrames={DURATION}
    fps={FPS}
    width={1920}
    height={1080}
  />
);
