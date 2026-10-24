/**
 * Circular avatars shown beside every chat message.
 *
 * No icon library is installed in this project, so both glyphs are small
 * inline stroke icons. They draw with `currentColor` and pick up their
 * colouring from `.msg-user .msg-avatar` / `.msg-assistant .msg-avatar` in the
 * stylesheet, so the icons stay consistent with the rest of SourceIQ's theme.
 */

/** Default profile avatar: a neutral person silhouette for user messages. */
export function PersonIcon() {
  return (
    <svg
      className="msg-avatar-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

/** Assistant avatar: a robot head, visually distinct from the person icon. */
function BotIcon() {
  return (
    <svg
      className="msg-avatar-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  );
}

/**
 * The avatar container rendered beside a message. The role alone decides the
 * glyph, size, colour and ordering, so user, assistant and streaming rows all
 * share one implementation.
 */
export function MessageAvatar({ role }: { role: 'user' | 'assistant' }) {
  return (
    <div className="msg-avatar" aria-hidden="true">
      {role === 'user' ? <PersonIcon /> : <BotIcon />}
    </div>
  );
}
