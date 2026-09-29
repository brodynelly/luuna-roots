// Record shapes for .roots/*.jsonl.

export const IDEA_STATUSES = ["planted", "shaping", "committed", "built", "composted"] as const;
export const SPROUT_STATUSES = ["open", "adopted", "rejected", "expired"] as const;
export const NODE_KINDS = ["idea", "sprout"] as const;
export const EDGE_RELS = ["serves", "tension", "replaces", "derives"] as const;

export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export type SproutStatus = (typeof SPROUT_STATUSES)[number];
export type NodeStatus = IdeaStatus | SproutStatus;
export type NodeKind = (typeof NODE_KINDS)[number];
export type EdgeRel = (typeof EDGE_RELS)[number];

/** `human:<name>`, `agent:<model>`, `roots`, or `roots:<rule>`. */
export type Actor = string;

export interface NodeRecord {
	type: "node";
	id: string;
	kind: NodeKind;
	slug: string;
	status: NodeStatus;
	author: Actor;
	createdAt: string;
	updatedAt?: string;
	/** Per-idea agent tier override (`roots tier <id> <0-3>`). */
	tier?: number;
	/**
	 * Sprouts only: when an open sprout expires (createdAt + limits.sproutTtlDays,
	 * fixed at creation). Expired lazily, like proposals.
	 */
	expiresAt?: string;
	/** Sprouts only: the human who adopted or rejected it. */
	decidedBy?: Actor;
	decidedAt?: string;
	decisionReason?: string;
	/**
	 * Ideas only: adopted by endorsement (`adopt --endorse`, tend [t]). The
	 * human's idea.md holds only their thoughts; the endorsed agent text is the
	 * sprout's sprout.md, pinned by its content hash at adoption.
	 */
	endorses?: { sprout: string; hash: string };
}

export interface EdgeRecord {
	type: "edge";
	id: string;
	from: string;
	to: string;
	rel: EdgeRel;
	by: Actor;
	proposedBy?: Actor;
	proposal?: string;
	createdAt: string;
}

export type GraphRecord = NodeRecord | EdgeRecord;

export interface Graph {
	nodes: NodeRecord[];
	edges: EdgeRecord[];
}

export interface Citation {
	node: string;
	quote: string;
}

export type HeadingStatus = "active" | "dismissed";

/**
 * One line of headings.jsonl: an agent's read on where a `roots flow` session
 * is going. Shown only in the flow pane, labeled [agent]; never in views or
 * prime. Dedup by id, last wins (dismissal rewrites the record).
 */
export interface HeadingRecord {
	id: string;
	flow: string;
	text: string;
	cites: Citation[];
	/** Idea the agent suggests thinking about next (optional). */
	next?: string;
	by: Actor;
	status: HeadingStatus;
	createdAt: string;
	dismissedBy?: Actor;
	dismissedAt?: string;
}

export type ProposalKind = "edge" | "split" | "merge" | "compost";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "expired";

export interface ProposalRecord {
	id: string;
	kind: ProposalKind;
	from?: string;
	to?: string;
	rel?: EdgeRel | null;
	reason?: string;
	cites: Citation[];
	by: Actor;
	status: ProposalStatus;
	createdAt: string;
	expiresAt?: string;
	decidedBy?: Actor;
	decidedAt?: string;
	decisionReason?: string;
}

export type QuestionStatus = "open" | "answered" | "dismissed" | "snoozed" | "delegated";

/** Agent research attached to a delegated question (`roots note --question`). */
export interface QuestionFinding {
	/** The note, relative to the project root (under .roots/agent/notes/). */
	note: string;
	by: Actor;
	at: string;
}

export interface QuestionRecord {
	id: string;
	node: string;
	text: string;
	by: Actor;
	status: QuestionStatus;
	createdAt: string;
	/**
	 * Rule-specific subject, part of the dedup key (e.g. the edge id for
	 * `roots:tension-open`, which asks once per tension edge).
	 */
	ref?: string;
	answeredBy?: Actor;
	answeredAt?: string;
	dismissedBy?: Actor;
	dismissedAt?: string;
	/** [a] in think: the human handed the question to the agent for research. */
	delegatedBy?: Actor;
	delegatedAt?: string;
	/** Research the agent attached; the question is open again once it has any. */
	findings?: QuestionFinding[];
	/** Snoozed questions come back once this time has passed. */
	snoozedUntil?: string;
	/** Session that asked or last acted on the question. */
	session?: string;
}

export type EventType =
	| "init"
	| "plant"
	| "session.start"
	| "session.end"
	| "ask"
	| "answer"
	| "dismiss"
	| "snooze"
	| "delegate"
	| "undelegate"
	| "propose"
	| "accept"
	| "reject"
	| "expire"
	| "sprout"
	| "adopt"
	| "mv"
	| "status"
	| "compost"
	| "link"
	| "unlink"
	| "tier"
	| "note"
	| "scan"
	| "flow.start"
	| "flow.end"
	| "heading"
	| "heading.dismiss";

/**
 * One line of events.jsonl. `node` is the primary subject; `refs` lists other
 * node ids the event concerns (so `roots log <id>` finds edge events from
 * both ends). Extra fields are event-specific.
 */
export interface EventRecord {
	type: EventType;
	by: Actor;
	at: string;
	node?: string;
	refs?: string[];
	[extra: string]: unknown;
}

export function isIdeaStatus(s: string): s is IdeaStatus {
	return (IDEA_STATUSES as readonly string[]).includes(s);
}

export function isSproutStatus(s: string): s is SproutStatus {
	return (SPROUT_STATUSES as readonly string[]).includes(s);
}

export function isNodeKind(s: string): s is NodeKind {
	return (NODE_KINDS as readonly string[]).includes(s);
}
