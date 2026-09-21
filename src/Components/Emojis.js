import EmojiPicker from "emoji-picker-react";
import { useTheme } from "next-themes";
import React, { useEffect, useRef, useState } from "react";
import Icon from "@/Components/Icon";
import useFlipPosition from "@/Hooks/useFlipPosition";

export default function Emojis({ setEmoji, position = "left" }) {
  // const isDarkMode = useSelector((state) => state.isDarkMode);
  const { resolvedTheme } = useTheme();
  const isDarkMode = ["dark", "gray", "system"].includes(resolvedTheme);
  const [showEmoji, setShowEmoji] = useState(false);
  const optionsRef = useRef(null);
  const pickerRef = useRef(null);
  // Flip below the trigger when there is no room above (issue #127).
  const { flip, shiftX, shiftY } = useFlipPosition(pickerRef, showEmoji, 300);

  useEffect(() => {
    const handleOffClick = (e) => {
      e.stopPropagation();
      if (optionsRef.current && !optionsRef.current.contains(e.target))
        setShowEmoji(false);
    };
    document.addEventListener("mousedown", handleOffClick);
    return () => {
      document.removeEventListener("mousedown", handleOffClick);
    };
  }, [optionsRef]);

  return (
    <div style={{ position: "relative" }} ref={optionsRef}>
      <div className="pointer" onClick={() => setShowEmoji(!showEmoji)}>
        <Icon name="emoji" size={24} opacity=".5" />
      </div>
      {showEmoji && (
        <div
          ref={pickerRef}
          className={`${position === "left" ? "drop-down-r" : "drop-down"}`}
          style={{
            position: "absolute",
            ...(flip
              ? { top: "calc(100% + 5px)", bottom: "auto" }
              : { bottom: "calc(100% + 5px)" }),
            ...(shiftX || shiftY
                ? { transform: `translate(${shiftX}px, ${shiftY}px)` }
                : {}),
            zIndex: 102,
          }}
        >
          <EmojiPicker
            reactionsDefaultOpen={true}
            theme={isDarkMode ? "dark" : "light"}
            previewConfig={{ showPreview: false }}
            skinTonesDisabled={true}
            searchDisabled={false}
            height={300}
            onEmojiClick={(data) => setEmoji(data.emoji)}
          />
        </div>
      )}
    </div>
  );
}
