/**
 * Telling a human what happened, after the fact.
 *
 * An autonomous council needs the opposite of a blocking prompt: it decides,
 * acts, and leaves a trail. Notifications are that trail's push half — ntfy
 * (which this account already uses for The Lab's alerts) and a generic webhook.
 *
 * Failures here are never fatal. A council run that worked but could not send a
 * notification is still a run that worked, so send errors are reported and
 * swallowed rather than thrown into the sweep.
 */

import type { Fetcher } from "./github.js";

export interface NotifyConfig {
  /** ntfy.sh topic, or a topic on a self-hosted server. */
  readonly ntfyTopic?: string;
  readonly ntfyServer?: string;
  /** Anything that accepts a JSON POST. */
  readonly webhookUrl?: string;
}

export type Urgency = "info" | "attention" | "urgent";

const PRIORITY: Record<Urgency, number> = { info: 2, attention: 4, urgent: 5 };
const TAGS: Record<Urgency, string[]> = {
  info: ["white_check_mark"],
  attention: ["warning"],
  urgent: ["rotating_light"],
};

export interface Notification {
  readonly title: string;
  readonly message: string;
  readonly urgency: Urgency;
  /** Clickable target — the PR, the issue, the run. */
  readonly url?: string;
  /** Anything structured a webhook consumer may want. */
  readonly data?: Record<string, unknown>;
}

export class Notifier {
  readonly #config: NotifyConfig;
  readonly #fetch: Fetcher;
  readonly sent: Notification[] = [];
  readonly failures: string[] = [];

  constructor(config: NotifyConfig, fetcher?: Fetcher) {
    this.#config = config;
    this.#fetch = fetcher ?? ((url, init) => fetch(url, init));
  }

  get configured(): boolean {
    return Boolean(this.#config.ntfyTopic || this.#config.webhookUrl);
  }

  async send(notification: Notification): Promise<void> {
    this.sent.push(notification);
    await Promise.all([this.#ntfy(notification), this.#webhook(notification)]);
  }

  async #ntfy(notification: Notification): Promise<void> {
    const topic = this.#config.ntfyTopic;
    if (!topic) return;
    const server = (this.#config.ntfyServer ?? "https://ntfy.sh").replace(/\/$/, "");
    try {
      const response = await this.#fetch(server, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic,
          title: notification.title,
          message: notification.message,
          priority: PRIORITY[notification.urgency],
          tags: TAGS[notification.urgency],
          ...(notification.url ? { click: notification.url } : {}),
        }),
      });
      if (!response.ok) this.failures.push(`ntfy ${response.status}`);
    } catch (error) {
      this.failures.push(`ntfy: ${(error as Error).message}`);
    }
  }

  async #webhook(notification: Notification): Promise<void> {
    const url = this.#config.webhookUrl;
    if (!url) return;
    try {
      const response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...notification, at: new Date().toISOString() }),
      });
      if (!response.ok) this.failures.push(`webhook ${response.status}`);
    } catch (error) {
      this.failures.push(`webhook: ${(error as Error).message}`);
    }
  }
}
