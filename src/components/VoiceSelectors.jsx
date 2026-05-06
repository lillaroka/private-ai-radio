export default function VoiceSelectors({ voiceOptions, voiceS1, voiceS2, onChangeS1, onChangeS2 }) {
  return (
    <div className="voice-selectors">
      <label>
        <span>声音1</span>
        <select value={voiceS1} onChange={(e) => onChangeS1(e.target.value)}>
          {voiceOptions.map((v) => (
            <option key={v.id} value={v.id}>{v.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>声音2</span>
        <select value={voiceS2} onChange={(e) => onChangeS2(e.target.value)}>
          {voiceOptions.map((v) => (
            <option key={v.id} value={v.id}>{v.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
