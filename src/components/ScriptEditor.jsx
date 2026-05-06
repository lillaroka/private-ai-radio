import { useState, useEffect, useRef } from "react";

export default function ScriptEditor({ initialScript, onSave }) {
  const [script, setScript] = useState(initialScript ?? "");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const dirtyRef = useRef(false);

  useEffect(() => {
    setScript(initialScript ?? "");
    dirtyRef.current = false;
  }, [initialScript]);

  function handleChange(e) {
    setScript(e.target.value);
    dirtyRef.current = true;
    setSaveStatus("");
  }

  async function handleSave() {
    if (!dirtyRef.current) return;
    setSaving(true);
    setSaveStatus("保存中...");
    try {
      await onSave(script);
      dirtyRef.current = false;
      setSaveStatus("已保存");
    } catch (err) {
      setSaveStatus("保存失败：" + err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="script-editor">
      <textarea value={script} onChange={handleChange} spellCheck="false" />
      <div className="script-editor-actions">
        <button onClick={handleSave} disabled={saving || !dirtyRef.current}>
          {saving ? "保存中..." : "保存脚本"}
        </button>
        {saveStatus ? <span className="save-status">{saveStatus}</span> : null}
      </div>
    </div>
  );
}
