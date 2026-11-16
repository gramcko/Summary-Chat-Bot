"use client";

import { AssistantChat } from "@/components/assistant/AssistantChat";
import { PageHeader } from "@/components/ui/States";

/**
 * Dashboard assistant: a browser-only conversation over monitored groups,
 * captured messages, and completed summaries. Nothing is persisted, and the
 * backend never returns provider keys or WhatsApp session material.
 */
export default function AssistantPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Assistant"
        description="Ask questions about the groups you monitor, the messages captured from them, and completed summaries. Every answer cites the groups, messages, or runs it used."
      />
      <AssistantChat />
    </div>
  );
}
