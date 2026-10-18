import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, streamChat } from '../api/client';
import type { Citation, ChatMessage } from '../api/types';
import { Alert } from '../components/Alert';
import { CitationList } from '../components/CitationList';
import { Spinner } from '../components/Spinner';
import { useAuth } from '../context/AuthContext';
import { useAsync } from '../hooks';

/** Render the answer, turning [n] markers into interactive citation chips. */
function AnswerBody({ content, onCite }: { content: string; onCite: (index: number) => void }) {
  return (
    <div className="msg-content">
      <ReactMarkdown
        components={{
          p: ({ children }) => <p>{renderWithCitations(children, onCite)}</p>,
          li: ({ children }) => <li>{renderWithCitations(children, onCite)}</li>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * react-markdown renders text nodes; we walk the React children and swap any
 * `[n]` string for a clickable chip.
 */
function renderWithCitations(children: React.ReactNode, onCite: (index: number) => void): React.ReactNode {
  return Array.isArray(children)
    ? children.map((child, i) => (typeof child === 'string' ? citeSplit(child, onCite, i) : child))
    : typeof children === 'string'
      ? citeSplit(children, onCite, 0)
      : children;
}

function citeSplit(text: string, onCite: (index: number) => void, keyOffset: number): React.ReactNode {
  return text.split(/(\[\d{1,2}\])/g).map((part, i) => {
    const match = /^\[(\d{1,2})\]$/.exec(part);
    if (!match) return <span key={`${keyOffset}-${i}`}>{part}</span>;
    const index = Number(match[1]) - 1;
    return (
      <button
        key={`${keyOffset}-${i}-cite`}
        type="button"
        className="cite-token"
        onClick={() => onCite(index)}
        title={`Jump to source ${index + 1}`}
      >
        {index + 1}
      </button>
    );
  });
}

export function ChatPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  // The admin uses the same chat to test the RAG system, and additionally gets
  // the library scope picker, source links and retrieval diagnostics. Anonymous
  // visitors see the question-and-answer experience only.
  const isAdmin = Boolean(user);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [streamingAnswer, setStreamingAnswer] = useState('');
  const [streamCitations, setStreamCitations] = useState<Citation[]>([]);
  const [sending, setSending] = useState(false);
  /**
   * True until the answer has been committed to `messages` (or the stream
   * failed). `sending` stays true a little longer than this: after the `done`
   * frame the server may still be finishing bookkeeping - on an unanswered
   * question it records the query before closing the stream - so the response
   * is still open while the answer is already on screen. The streaming bubble
   * must disappear when the answer lands, not when the socket closes,
   * otherwise its empty branch re-renders as a "Searching your documents…"
   * spinner underneath the finished answer.
   */
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCitationIndex, setActiveCitationIndex] = useState<number | null>(null);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // The document library is administrative context: only the admin loads it.
  const documents = useAsync(
    () => (isAdmin ? api.listDocuments({ status: 'ready' }) : Promise.resolve({ documents: [] })),
    [isAdmin],
  );

  // Scope the chat to documents passed via ?documents=<id>
  useEffect(() => {
    const param = searchParams.get('documents');
    setSelectedDocumentIds(param ? param.split(',').filter(Boolean) : []);
  }, [searchParams]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamingAnswer]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      setError(null);
      setSending(true);
      setStreaming(true);
      setStreamingAnswer('');
      setStreamCitations([]);
      setActiveCitationIndex(null);

      const localUserMessage: ChatMessage = {
        id: `local-${Date.now()}`,
        role: 'user',
        content: trimmed,
        citations: [],
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, localUserMessage]);
      setQuestion('');

      const controller = new AbortController();
      abortRef.current = controller;

      let accumulated = '';

      try {
        await streamChat(
          {
            question: trimmed,
            ...(selectedDocumentIds.length ? { documentIds: selectedDocumentIds } : {}),
          },
          {
            onCitations: (payload) => {
              setStreamCitations(payload.citations);
            },
            onDelta: (delta) => {
              accumulated += delta;
              setStreamingAnswer(accumulated);
            },
            onDone: (payload) => {
              setMessages((prev) => [
                ...prev,
                {
                  id: `assistant-${Date.now()}`,
                  role: 'assistant',
                  content: accumulated,
                  // The server reports only the passages the answer actually
                  // referenced; the retrieved set is for live streaming only.
                  citations: payload.citations,
                  createdAt: new Date().toISOString(),
                },
              ]);
              setStreamingAnswer('');
              setStreamCitations([]);
              // The answer is in `messages`: stop showing the streaming bubble
              // now, rather than waiting for the response to close.
              setStreaming(false);
            },
            onError: (payload) => {
              setStreaming(false);
              setError(payload.message);
            },
          },
          controller.signal,
        );
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          setError(err instanceof ApiError ? err.message : 'The request failed.');
        }
      } finally {
        // Covers the aborted case, where no done frame ever arrives.
        setStreaming(false);
        setSending(false);
        abortRef.current = null;
      }
    },
    [selectedDocumentIds, sending],
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(question);
  }

  function toggleDocument(id: string) {
    setSelectedDocumentIds((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]));
  }

  const readyDocs = documents.data?.documents ?? [];
  // `activeCitationIndex` is the [n] the reader clicked; `activeCitation` is the
  // resolved Citation shown in the preview strip.
  const activeCitation =
    activeCitationIndex !== null ? (streamCitations[activeCitationIndex] ?? null) : null;

  return (
    <div className={`chat-layout${isAdmin ? '' : ' chat-layout-full'}`}>
      {isAdmin ? (
        <aside className="chat-sidebar">
          <div className="card">
            <h3 className="panel-label">Scope</h3>
            {documents.loading ? (
              <Spinner />
            ) : readyDocs.length === 0 ? (
              <p className="small faint">No indexed documents yet. Upload a PDF first.</p>
            ) : (
              <div className="scope-list">
                {readyDocs.map((doc) => (
                  <label key={doc.id} className="scope-option">
                    <input
                      type="checkbox"
                      checked={selectedDocumentIds.includes(doc.id)}
                      onChange={() => toggleDocument(doc.id)}
                    />
                    <span className="truncate" title={doc.title}>
                      {doc.title}
                    </span>
                  </label>
                ))}
                {selectedDocumentIds.length > 0 ? (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelectedDocumentIds([])}>
                    Clear selection
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </aside>
      ) : null}

      <section className="chat-panel">
        {error ? (
          <div style={{ padding: '1rem 1.25rem 0' }}>
            <Alert tone="error" title="Chat error" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          </div>
        ) : null}

        <div className="chat-messages" data-testid="chat-messages">
          {messages.length === 0 && !sending ? (
            // Deliberate minimal empty state: the conversation area keeps its
            // height and the composer stays anchored at the bottom. Only the
            // old heading, explanatory paragraph and example-question list were
            // removed — the container itself remains.
            <div className="chat-empty">
              <p className="chat-empty-hint">No messages yet — your conversation with SourceIQ will appear here.</p>
            </div>
          ) : null}

          {messages.map((message) => (
            <div
              key={message.id}
              className={`msg msg-${message.role}`}
              data-testid={`message-${message.role}`}
            >
              <div className="msg-avatar" aria-hidden="true">
                {message.role === 'user' ? 'You' : 'AI'}
              </div>
              <div className="msg-body">
                <div className="msg-role">{message.role === 'user' ? 'You' : 'SourceIQ'}</div>
                {message.role === 'user' ? (
                  <div className="msg-content">{message.content}</div>
                ) : (
                  <>
                    <AnswerBody
                      content={message.content}
                      onCite={(index) => {
                        setStreamCitations(message.citations);
                        setActiveCitationIndex(index);
                      }}
                    />
                    <CitationList
                      citations={message.citations}
                      showDiagnostics={isAdmin}
                      {...(isAdmin
                        ? {
                            onOpenDocument: (documentId: string, chunkId: string) =>
                              navigate(`/admin/documents/${documentId}?chunk=${encodeURIComponent(chunkId)}`),
                          }
                        : {})}
                    />
                  </>
                )}
              </div>
            </div>
          ))}

          {streaming ? (
            <div className="msg msg-assistant" data-testid="message-streaming">
              <div className="msg-avatar" aria-hidden="true">
                AI
              </div>
              <div className="msg-body">
                <div className="msg-role">SourceIQ</div>
                {streamingAnswer ? (
                  <>
                    {/* Streamed text is rendered by the same component as the
                        finished answer. A plain-text preview here was discarded
                        and re-rendered as markdown when the stream completed,
                        which changed the answer's layout (paragraph margins,
                        citation chips) after it had appeared, while the
                        auto-scroll animation was still chasing the old height. */}
                    <AnswerBody
                      content={streamingAnswer}
                      onCite={(index) => setActiveCitationIndex(index)}
                    />
                    <CitationList citations={streamCitations} showDiagnostics={isAdmin} />
                  </>
                ) : (
                  <div className="row">
                    <Spinner label="Searching your documents and drafting an answer…" />
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <div ref={endRef} />
        </div>

        <form className="chat-composer" onSubmit={onSubmit}>
          {activeCitation ? (
            <div className="alert alert-info" style={{ margin: 0 }}>
              <span aria-hidden="true">❝</span>
              <div className="alert-body small">
                <strong>{activeCitation.documentTitle}</strong>
                {activeCitation.page ? ` · page ${activeCitation.page}` : ''}
                {isAdmin ? ` · similarity ${activeCitation.score.toFixed(3)}` : ''}
                <div className="citation-snippet" style={{ marginTop: '0.3rem' }}>
                  {activeCitation.snippet}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setActiveCitationIndex(null)}
                aria-label="Close source preview"
              >
                ✕
              </button>
            </div>
          ) : null}

          <div className="composer-row">
            <textarea
              className="textarea"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(question);
                }
              }}
              placeholder="Ask a question about your documents…  (Enter to send, Shift+Enter for a new line)"
              aria-label="Your question"
              data-testid="chat-input"
              rows={1}
              disabled={sending}
            />
            {sending ? (
              <button type="button" className="btn btn-danger" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={question.trim().length === 0}>
                Send
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}