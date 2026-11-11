"use client";

/**
 * The "Study time" settings section (design: docs/designs/study-time.md):
 * the idle limit and the first day of the week. Replace-whole section PUTs
 * through the dialog's single writer, like GraphSection.
 */
import {
	STUDY_IDLE_MINUTES_MAX,
	STUDY_IDLE_MINUTES_MIN,
	type StudyTimeSettings,
} from "@/src/core";
import { CommitInput, SettingsRow, ThinSelect } from "./controls.tsx";

export function StudyTimeSection({
	studyTime,
	resolved,
	onSectionChange,
}: {
	studyTime: StudyTimeSettings | undefined;
	resolved: Required<StudyTimeSettings>;
	onSectionChange: (next: StudyTimeSettings) => boolean | Promise<boolean>;
}) {
	return (
		<>
			<SettingsRow label="Idle limit (minutes)" hint={`${resolved.idleMinutes} min`} testid="study-row-idle">
				<CommitInput
					type="number"
					value={String(studyTime?.idleMinutes ?? "")}
					placeholder={String(resolved.idleMinutes)}
					ariaLabel="idle limit in minutes"
					testid="input-study-idle"
					onCommit={(v) => {
						// Empty = factory default (absence is the unset for numbers).
						if (v === "") return onSectionChange({ ...studyTime, idleMinutes: undefined });
						const n = Number(v);
						if (!Number.isFinite(n)) return false; // bad input: no write
						return onSectionChange({
							...studyTime,
							idleMinutes: Math.min(STUDY_IDLE_MINUTES_MAX, Math.max(STUDY_IDLE_MINUTES_MIN, Math.round(n))),
						});
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Week starts on" testid="study-row-week-start">
				<ThinSelect
					value={studyTime?.weekStart ?? resolved.weekStart}
					ariaLabel="week starts on"
					testid="select-study-week-start"
					onChange={(next) => { void onSectionChange({ ...studyTime, weekStart: next === "sunday" ? "sunday" : "monday" }); }}
				>
					<option value="monday">Monday</option>
					<option value="sunday">Sunday</option>
				</ThinSelect>
			</SettingsRow>
		</>
	);
}
