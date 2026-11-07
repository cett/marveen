// What sendPromptToSession() reports. Kept in its own tiny module (no tmux, no db) so callers can classify the
// result without importing the session layer, and so a test that mocks that layer still gets the real classifier.
export type SendPromptResult = 'sent' | 'aborted-busy' | 'skipped-locked'

// True when the prompt did NOT reach the pane: the typed text was refused or skipped, so a caller that records
// "delivered" / "fired" afterwards would record something that did not happen.
//   'aborted-busy'   no keystrokes were sent (the pane never idled for an abort-policy caller, or it sits on the
//                    external CLAUDE.md imports dialog, which swallows the text and answers "No" on Enter).
//   'skipped-locked' a recover-mode send found the pane lane held by a live delivery and stepped aside.
// Deliberately matches the two refusal values, NOT "anything but 'sent'": a mocked or older sender that returns
// nothing (undefined) must stay on the delivered path, exactly as before this classifier existed.
export function wasPromptRefused(result: unknown): result is 'aborted-busy' | 'skipped-locked' {
  return result === 'aborted-busy' || result === 'skipped-locked'
}
