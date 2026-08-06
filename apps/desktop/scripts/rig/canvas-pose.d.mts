/**
 * Types for the canvas pose.
 *
 * The pose itself is plain `.mjs` because the rig scripts are plain node and
 * cannot import TypeScript; this is what lets the contract test — which runs
 * under tsc — import the same single source rather than copy it.
 */
import type { Board, StoryGraph } from "../../src/api/types";

export declare const POSE_GRAPH: StoryGraph;
export declare const POSE_SELECTED: string;
export declare const POSE_QUERY: string;
export declare const POSE_LAYOUT: {
  width: number;
  height: number;
  nodes: Record<string, { x: number; y: number }>;
};
export declare const POSE_CHAIN: string[];
export declare function poseBoard(keyframeHash?: string | null): Board;
