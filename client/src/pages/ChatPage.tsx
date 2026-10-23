import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, streamChat } from '../api/client';
import type { ChatMessage } from '../api/types';
import { Alert } from '../components/Alert';
import { Spinner } from '../components/Spinner';
import { useAuth } from '../context/AuthContext';
import { useAsync } from '../hooks';

/** Render the answer as markdown (sources and their numbering are not shown in chat). */
function AnswerBody({ content }: { content: string }) {
  const cleaned = content.replace(/\[\d{1,2}\]/g, '');
  return (
    <div className="msg-content">
      <ReactMarkdown>{cleaned}</ReactMarkdown>
    </div>
  );
}

export function ChatPage() {
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  // The admin uses the same chat to test the RAG system, and additionally gets
  // the library scope picker, source links and retrieval diagnostics. Anonymous
  // visitors see the question-and-answer experience only.
  const isAdmin = Boolean(user);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [streamingAnswer, setStreamingAnswer] = useState('');
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
            onDelta: (delta) => {
              accumulated += delta;
              setStreamingAnswer(accumulated);
            },
            onDone: () => {
              setMessages((prev) => [
                ...prev,
                {
                  id: `assistant-${Date.now()}`,
                  role: 'assistant',
                  content: accumulated,
                  // Sources are not displayed in chat.
                  citations: [],
                  createdAt: new Date().toISOString(),
                },
              ]);
              setStreamingAnswer('');
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
          <div className="chat-alert">
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
              <div>
                <div className="chat-empty-mark" aria-hidden="true">
                  S
                </div>
                <p className="chat-empty-hint">
                  No messages yet — your conversation with SourceIQ will appear here.
                </p>
              </div>
            </div>
          ) : null}

          <div className="chat-thread">
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
                      <AnswerBody content={message.content} />
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
                      <AnswerBody content={streamingAnswer} />
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
        </div>

        <form className="chat-composer" onSubmit={onSubmit}>
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
              placeholder="Ask a question about your documents…"
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