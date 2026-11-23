// Shared data model for board.json (see SPEC.md section 3).

export type Kind = 'image' | 'text' | 'link' | 'arrow' | 'mark';
export type By = 'agent' | 'human';
export type Intent = 'change' | 'question' | 'keep' | 'bug';

export interface Version {
  v: number;
  at: string;
  asset?: string;   // file name in .drawpad/assets
  thumb?: string;   // smaller copy for zoomed-out views
  pw?: number;      // pixel size of the asset
  ph?: number;
  text?: string;    // text items
  url?: string;     // link items
  note?: string;
}

export interface Source { commit?: string; launch?: string; files?: string[]; note?: string }

export interface Comment {
  intent: Intent;
  status: 'open' | 'addressed' | 'resolved';
  thread: { by: By; text: string; at: string; sent?: number; delivered?: boolean }[];
  target?: string;          // item id
  targetVersion?: number;
  point?: [number, number]; // item-local, 0..1
  region?: [number, number, number, number]; // x, y, w, h item-local
  crop?: string;            // asset file
  artifact?: string;        // key the agent named when marking done
}

// The human's drawings. On an item (on = its id): pts are 0..1 of that item and move with it. Otherwise world coords.
export interface Mark { shape: 'line' | 'arrow' | 'rect' | 'ellipse'; pts: [number, number, number, number]; on?: string; crop?: string }

export interface Reaction { kind: 'approve' | 'reject'; reason?: string; version: number; sent?: number; delivered?: boolean }

export interface Item {
  id: string;
  key: string;
  kind: Kind;
  x: number; y: number; w: number; h: number; z: number;
  title?: string;
  section?: string;  // section id
  state: 'active' | 'archived' | 'not_chosen';
  versions: Version[];
  source?: Source;
  createdBy: By;
  round: number;
  createdAt: string;
  rev: number;            // revision of the last change
  seenByHuman: boolean;
  sent?: number;          // human items: revision at which they were sent (undefined = draft)
  delivered?: boolean;    // human items: reported to the agent by `feedback`
  color?: string;
  comment?: Comment;
  mark?: Mark;
  // arrows
  from?: string;
  to?: string;
  toPoint?: [number, number];
  label?: string;
  reaction?: Reaction;
}

// x, y: where the first member goes. w, h: set for frames the human drew or resized (the box never shrinks below them).
export interface Section { id: string; title: string; x: number; y: number; rev: number; w?: number; h?: number }

export interface Board {
  schemaVersion: number;
  revision: number;
  nextId: number;
  id: string;
  name: string;
  background: 'dark' | 'light';
  round: number;
  items: Item[];
  sections: Section[];
  relations: unknown[];
  groups: unknown[];
  rounds: { id: number; at: string; label: string }[];
}
