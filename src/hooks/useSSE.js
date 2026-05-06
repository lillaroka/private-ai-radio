import { useRef, useCallback } from "react";

export function useSSE() {
  const abortRef = useRef(null);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const call = useCallback(async (url, { method = "POST", body, onProgress, onDone, onError }) => {
    abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let episodeData = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = JSON.parse(line.slice(6));

          if (data.stage === "done" && data.episode) {
            episodeData = data.episode;
          } else if (data.stage === "error") {
            throw new Error(data.error ?? "生成失败");
          } else {
            onProgress?.({ stage: data.stage, detail: data.detail ?? {} });
          }
        }
      }

      if (!episodeData) {
        throw new Error("生成失败：未收到完成数据");
      }

      onDone?.(episodeData);
      return episodeData;
    } catch (caught) {
      if (caught.name === "AbortError") return;
      onError?.(caught.message);
      throw caught;
    } finally {
      abortRef.current = null;
    }
  }, [abort]);

  return { call, abort };
}
