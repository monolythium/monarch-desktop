import { useCallback, useEffect, useRef, useState } from "react";
import { askMonarch, listenAskStream } from "../sdk";
import type { AskDonePayload, AskErrorPayload, ProposedAction } from "../sdk";
import { proposedActionToOpRequest, useOps } from "../ops";
import { useNavigate } from "react-router-dom";

type Suggestion = {
  title: string;
  caption: string;
  action: ProposedAction | null;
  route?: { path: string; event?: { name: string; detail: string } };
};

type Reply = {
  q: string;
  summary: string;
  cards: Suggestion[];
  confidence: number;
  streaming?: boolean;
  provider?: string;
  model?: string;
  error?: string;
};

export function AskRail() {
  const ops = useOps();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState<Reply[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const startLiveAsk = useCallback(
    async (q: string): Promise<void> => {
      const mutateInFlight = (mut: (reply: Reply) => Reply) => {
        setTranscript((prev) => {
          const idx = prev.findIndex(
            (r) => r.q === q && r.streaming === true,
          );
          if (idx < 0) return prev;
          const target = prev[idx];
          if (!target) return prev;
          const next = prev.slice();
          next[idx] = mut(target);
          return next;
        });
      };

      let correlationId: number;
      try {
        correlationId = await askMonarch(q);
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        mutateInFlight((r) => ({
          ...r,
          streaming: false,
          error: msg,
          summary: msg,
          cards: [],
          confidence: 0,
          provider: "unavailable",
          model: "none",
        }));
        return;
      }

      await listenAskStream(correlationId, {
        onChunk: (chunk: string) => {
          mutateInFlight((r) => ({ ...r, summary: r.summary + chunk }));
        },
        onDone: (payload: AskDonePayload) => {
          const proposed = payload.proposed_action;
          mutateInFlight((r) => ({
            ...r,
            summary: payload.text.trim() || r.summary || "(empty reply)",
            cards: proposed
              ? [{ title: proposed.title, caption: proposed.sub, action: proposed }]
              : [],
            streaming: false,
            provider: payload.provider,
            model: payload.model,
          }));

          if (proposed) {
            const req = proposedActionToOpRequest(proposed, {
              query: q,
              provider: payload.provider,
              model: payload.model,
            });
            if (req) ops.requestOp(req);
          }
        },
        onError: (payload: AskErrorPayload) => {
          mutateInFlight((r) => ({
            ...r,
            summary: payload.error,
            error: payload.error,
            streaming: false,
            cards: [],
            confidence: 0,
          }));
        },
      });
    },
    [ops],
  );

  const ask = useCallback(
    (q: string) => {
      setOpen(true);
      setTranscript((prev) => [
        ...prev,
        { q, summary: "", cards: [], confidence: 0.5, streaming: true },
      ]);
      void startLiveAsk(q);
    },
    [startLiveAsk],
  );

  useEffect(() => {
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail.trim()) ask(detail.trim());
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("monarch:ask", onAsk as EventListener);
    window.addEventListener("monarch:ask-open", onOpen);
    return () => {
      window.removeEventListener("monarch:ask", onAsk as EventListener);
      window.removeEventListener("monarch:ask-open", onOpen);
    };
  }, [ask]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript.length]);

  const fireSuggestion = (reply: Reply, suggestion: Suggestion) => {
    if (suggestion.route) {
      navigate(suggestion.route.path);
      setOpen(false);
      const event = suggestion.route.event;
      if (event) {
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent(event.name, { detail: event.detail }),
          );
        }, 80);
      }
      return;
    }
    if (!suggestion.action) return;
    const req = proposedActionToOpRequest(suggestion.action, {
      query: reply.q,
      provider: reply.provider ?? "local",
      model: reply.model ?? "local",
    });
    if (req) ops.requestOp(req);
  };

  return (
    <>
      <div
        className={open ? "askrail-mask is-open" : "askrail-mask"}
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <aside className={open ? "askrail is-open" : "askrail"} aria-label="Ask Monarch">
        <header className="askrail__head">
          <div className="monarch-askbar__sigil" aria-hidden />
          <div>
            <div className="cap">Ask Monarch · advisory</div>
            <h2>Operational context</h2>
          </div>
          <button type="button" className="drawer__close" onClick={() => setOpen(false)}>
            ×
          </button>
        </header>
        <div ref={listRef} className="askrail__body">
          {transcript.length === 0 ? (
            <p className="askrail__empty">
              Ask a question from the bottom bar. Suggested actions always open a diff preview first.
            </p>
          ) : (
            transcript.map((reply, i) => (
              <div className="askrail__reply" key={`${reply.q}-${i}`}>
                <div className="askrail__reply-head">
                  <span className="cap">
                    summary
                  </span>
                  {reply.streaming ? (
                    <span className="halo halo--info"><span className="dot" /> streaming</span>
                  ) : reply.error ? (
                    <span className="halo halo--err"><span className="dot" /> error</span>
                  ) : null}
                </div>
                <h3>{reply.q}</h3>
                <p>{reply.summary}{reply.streaming ? <span aria-hidden> ▍</span> : null}</p>
                {reply.cards.length > 0 ? (
                  <div className="askrail__actions">
                    <div className="cap">suggested actions</div>
                    {reply.cards.map((card, idx) => (
                      <button
                        key={`${card.title}-${idx}`}
                        type="button"
                        className="askrail__action"
                        disabled={!card.action && !card.route}
                        onClick={() => fireSuggestion(reply, card)}
                      >
                        <span>
                          <b>{card.title}</b>
                          <small>{card.caption}</small>
                        </span>
                        {card.action || card.route ? <i aria-hidden>→</i> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="askrail__seatbelt">
                  Monarch is advisory. Nothing runs without diff preview and keychain confirmation.
                </div>
                <div className="askrail__meta">
                  <span>confidence · {(reply.confidence * 100).toFixed(0)}%</span>
                  <span>
                    {reply.provider && reply.model
                      ? `${reply.provider} · ${reply.model}`
                      : reply.streaming
                        ? "streaming"
                        : "advisory"}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
