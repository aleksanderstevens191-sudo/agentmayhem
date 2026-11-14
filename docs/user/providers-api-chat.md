# API Chat

API chat talks to a model through its API with your own key, so nothing has to be installed. It
fits plain conversation: asking questions, drafting, and talking through ideas. It cannot read or
edit files or run commands. For coding work, use an agent such as Claude or Codex.

## Set Up API Chat

1. Open **Settings → Providers → Add provider** and choose **API chat**.
2. Pick the **Service**: Anthropic (Claude), Google (Gemini), OpenAI, OpenRouter, or Custom for any
   OpenAI-compatible endpoint, such as `http://localhost:11434/v1` for Ollama. Custom also needs a
   **Base URL**.
3. After adding it, paste the key under **API key**. Custom endpoints that take no key can leave it
   empty.

The provider's status shows **Authenticated** once the service accepts the key. Add one API chat
provider per service or account, and name each one so the model picker tells them apart.

## Models

The model picker lists the models the service offers, newest first, and new threads start on the
newest. When a service lists no models, or lists one under another name, add its id under
**Custom models**.

## What It Can Do

- Replies stream in as the model writes them. Stop keeps what was already written.
- Pasted images, text files, and the text of Word, Excel, and PowerPoint documents go to the model.
  Other files, such as PDFs, are not read yet. Models that cannot read images refuse them.
- The model can use T3 Code's own tools, including shared memory, so what you tell one agent is
  there when you chat here.
- A rate limit or spent quota counts as a usage limit, so a thread can
  [move to a fallback agent](./thread-sidebar.md#inspect-agent-work) like any other.

The key stays on the T3 Code server, which sends the requests. Each conversation is kept on that
server too, so a thread picks up where it left off after a restart.
