"use client";

import { useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { fitGraphView, pinchedGraphView, zoomedGraphView, type Viewport } from "@/components/pan-zoom";

type Point = { x: number; y: number };
type Gesture =
	| { kind: "pan"; start: Point; view: Viewport; moved: boolean }
	| { kind: "pinch"; dist: number; mid: Point; view: Viewport };

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 24;
const DOUBLE_TAP_ZOOM = 2;

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Pointer handlers for the pan/zoom viewports (plan popup, diagram focus).
 *  One pointer pans above the fit floor; two pointers pinch around their
 *  midpoint; a touch double-tap zooms in at the tap, or back to the fit.
 *  Every gesture reads the view it started from, so a second finger landing
 *  mid-drag re-anchors instead of jumping. */
export function usePanZoomGestures({
	view, setView, fitZoom, box, size, onAdjust,
}: {
	view: Viewport;
	setView: Dispatch<SetStateAction<Viewport>>;
	fitZoom: number;
	box: { w: number; h: number };
	size: { w: number; h: number };
	/** The learner moved or zoomed the view (stops auto-refit). */
	onAdjust: () => void;
}) {
	const viewRef = useRef(view);
	viewRef.current = view;
	const pointers = useRef(new Map<number, Point>());
	const gesture = useRef<Gesture | null>(null);
	const lastTap = useRef<{ at: number; p: Point } | null>(null);
	const [active, setActive] = useState(false);

	const local = (e: ReactPointerEvent<HTMLElement>): Point => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	};
	const atFloor = (v: Viewport) => v.zoom <= fitZoom + 1e-9;

	const begin = () => {
		const pts = [...pointers.current.values()];
		if (pts.length >= 2) {
			gesture.current = { kind: "pinch", dist: Math.max(distance(pts[0]!, pts[1]!), 1), mid: midpoint(pts[0]!, pts[1]!), view: viewRef.current };
		} else if (pts.length === 1) {
			gesture.current = { kind: "pan", start: pts[0]!, view: viewRef.current, moved: false };
		} else {
			gesture.current = null;
		}
	};

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		if ((e.target as HTMLElement).closest("button")) return;
		pointers.current.set(e.pointerId, local(e));
		e.currentTarget.setPointerCapture(e.pointerId);
		begin();
		setActive(true);
		if (!atFloor(viewRef.current)) e.currentTarget.classList.add("cursor-grabbing");
	};

	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (!pointers.current.has(e.pointerId)) return;
		pointers.current.set(e.pointerId, local(e));
		const g = gesture.current;
		if (!g) return;
		if (g.kind === "pinch") {
			const pts = [...pointers.current.values()];
			if (pts.length < 2) return;
			setView(pinchedGraphView(g.view, distance(pts[0]!, pts[1]!) / g.dist, g.mid, midpoint(pts[0]!, pts[1]!), fitZoom, box, size));
			onAdjust();
			return;
		}
		const p = pointers.current.get(e.pointerId)!;
		const dx = p.x - g.start.x;
		const dy = p.y - g.start.y;
		if (!g.moved && Math.hypot(dx, dy) < 3) return;
		g.moved = true;
		if (atFloor(g.view)) return;
		setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
		onAdjust();
	};

	const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		const p = pointers.current.get(e.pointerId);
		if (!p) return;
		const g = gesture.current;
		const tap = g?.kind === "pan" && !g.moved && pointers.current.size === 1 && e.type === "pointerup";
		pointers.current.delete(e.pointerId);
		begin();
		if (pointers.current.size === 0) {
			setActive(false);
			e.currentTarget.classList.remove("cursor-grabbing");
		}
		if (!tap || e.pointerType === "mouse") return;
		const prev = lastTap.current;
		const now = e.timeStamp;
		if (prev && now - prev.at < DOUBLE_TAP_MS && distance(prev.p, p) < DOUBLE_TAP_SLOP) {
			lastTap.current = null;
			const v = viewRef.current;
			setView(v.zoom > fitZoom * 1.5
				? fitGraphView(box, size, fitZoom)
				: zoomedGraphView(v, (fitZoom * DOUBLE_TAP_ZOOM) / v.zoom, fitZoom, p, box, size));
			onAdjust();
		} else {
			lastTap.current = { at: now, p };
		}
	};

	return {
		/** True while any pointer is down: callers drop the transform transition. */
		active,
		handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
	};
}
