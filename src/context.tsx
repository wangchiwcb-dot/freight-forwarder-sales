import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  useCallback,
  type ReactNode,
  type RefObject,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Scope, User } from "./model";
import { request, resetSession } from "./api";
interface Context {
  user: User;
  scope: Scope;
  setScope: (scope: Scope) => void;
  dirty: boolean;
  dirtyRef: RefObject<boolean>;
  setDirty: (dirty: boolean) => void;
  logout: () => Promise<void>;
}
const WorkContext = createContext<Context | null>(null);
export function WorkProvider({
  user,
  children,
}: {
  user: User;
  children: ReactNode;
}) {
  const [scope, setScope] = useState<Scope>({ scope: "mine" });
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const setDirty = useCallback((v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
  }, []);
  const qc = useQueryClient();
  async function logout() {
    await request("/auth/logout", { method: "POST", body: "{}" });
    resetSession();
    qc.clear();
    window.location.assign("/login");
  }
  return (
    <WorkContext.Provider
      value={{ user, scope, setScope, dirty, dirtyRef, setDirty, logout }}
    >
      {children}
    </WorkContext.Provider>
  );
}
export function useWork() {
  const context = useContext(WorkContext);
  if (!context) throw Error("Missing workspace context");
  return context;
}
export function useUnsaved(dirty: boolean) {
  const { setDirty } = useWork();
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);
  useEffect(() => {
    if (!dirty) return;
    const fn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", fn);
    return () => window.removeEventListener("beforeunload", fn);
  }, [dirty]);
}
