"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Modal, Spinner, api, formatDate, useLoader } from "@/components/ui";

type Audience = { finalRecipients: number; estimatedDuration: string; maxEmailsPerHour: number };

function formatDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseLocalDateTime(date: string, time: string): Date | null {
  if (!date || !time) return null;
  const parsed = new Date(`${date}T${time}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function oneHourFromNow(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
}

function isNotInFuture(date: Date): boolean {
  return date.getTime() <= Date.now();
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min ${seconds} s`;
  return `${seconds} s`;
}

/**
 * Shown for a SCHEDULED campaign in place of the composer/report: it hasn't
 * started yet, so there is nothing to report on, but the admin still needs to
 * see when it fires and be able to change their mind.
 */
export default function CampaignScheduled({
  campaignId, subject, scheduledAt, onRescheduled, onCancelled,
}: {
  campaignId: string;
  subject: string;
  scheduledAt: string | null;
  onRescheduled: (scheduledAt: string) => void;
  onCancelled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [parts, setParts] = useState(() => {
    const current = scheduledAt ? new Date(scheduledAt) : oneHourFromNow();
    return { date: formatDateInput(current), time: formatTimeInput(current) };
  });

  // Set after mount so the server-rendered HTML never disagrees with the client clock.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  const msUntilStart = scheduledAt && now !== null ? new Date(scheduledAt).getTime() - now : null;

  const fetchAudience = useCallback(() => api<Audience>(`/api/campaigns/${campaignId}/audience`), [campaignId]);
  const { data: audience } = useLoader(fetchAudience);

  const reschedule = async () => {
    const next = parseLocalDateTime(parts.date, parts.time);
    if (!next || isNotInFuture(next)) {
      setError("Pick a date and time in the future.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/campaigns/${campaignId}/reschedule`, {
        method: "POST",
        body: JSON.stringify({ scheduledAt: next.toISOString() }),
      });
      onRescheduled(next.toISOString());
      setEditOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reschedule");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!confirm("Cancel this scheduled campaign? It will not be sent.")) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/campaigns/${campaignId}/cancel`, { method: "POST" });
      onCancelled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel");
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <section className="card p-4">
        <p className="text-sm"><span className="hint">Subject: </span>{subject || "No subject"}</p>
        <dl className="mt-3 grid gap-2 text-sm">
          <div className="flex flex-wrap gap-2 border-b pb-2">
            <dt className="hint w-40 shrink-0">Scheduled for</dt>
            <dd className="flex-1 font-medium">
              {formatDate(scheduledAt)}
              {now !== null ? (
                <span className="hint font-normal"> ({Intl.DateTimeFormat().resolvedOptions().timeZone})</span>
              ) : null}
            </dd>
          </div>
          {msUntilStart !== null && msUntilStart > 0 ? (
            <div className="flex flex-wrap gap-2 border-b pb-2">
              <dt className="hint w-40 shrink-0">Starts in</dt>
              <dd className="flex-1 font-medium tabular-nums">{formatCountdown(msUntilStart)}</dd>
            </div>
          ) : msUntilStart !== null ? (
            <div className="flex flex-wrap gap-2 border-b pb-2">
              <dt className="hint w-40 shrink-0">Starts in</dt>
              <dd className="flex-1 font-medium">
                {msUntilStart > -60_000
                  ? "Due now — waiting for the worker's next tick"
                  : `Was due ${formatCountdown(-msUntilStart)} ago — still waiting for the worker`}
              </dd>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2 pb-2">
            <dt className="hint w-40 shrink-0">Recipients</dt>
            <dd className="flex-1">
              {audience === null ? <Spinner label="Calculating…" /> : audience.finalRecipients.toLocaleString()}
            </dd>
          </div>
        </dl>
        <p className="hint mt-3">
          This campaign will start sending automatically at the time above, using your configured rate limit.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn" disabled={busy} onClick={() => setEditOpen(true)}>Reschedule</button>
          <button className="btn btn-danger" disabled={busy} onClick={cancel}>Cancel campaign</button>
        </div>
      </section>

      <Modal open={editOpen} title="Reschedule this campaign" onClose={() => setEditOpen(false)}>
        <div className="grid gap-3 text-sm">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor="rescheduleDate">Date</label>
              <input
                id="rescheduleDate"
                className="input"
                type="date"
                value={parts.date}
                min={formatDateInput(new Date())}
                onChange={(e) => setParts((p) => ({ ...p, date: e.target.value }))}
              />
            </div>
            <div>
              <label className="label" htmlFor="rescheduleTime">Time</label>
              <input
                id="rescheduleTime"
                className="input"
                type="time"
                value={parts.time}
                onChange={(e) => setParts((p) => ({ ...p, time: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={reschedule}>
              {busy ? "Saving…" : "Save new time"}
            </button>
            <button className="btn" onClick={() => setEditOpen(false)} disabled={busy}>Cancel</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
