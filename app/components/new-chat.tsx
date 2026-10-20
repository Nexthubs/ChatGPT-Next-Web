import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Path } from "../constant";
import { useChatStore } from "../store";

export function NewChat() {
  const chatStore = useChatStore();
  const navigate = useNavigate();

  // 防止 React StrictMode 开发环境下重复创建两次会话
  const hasStarted = useRef(false);

  useEffect(() => {
    if (hasStarted.current) return;

    hasStarted.current = true;

    chatStore.newSession();
    navigate(Path.Chat);
  }, [chatStore, navigate]);

  return null;
}
