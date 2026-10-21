import { useEffect, useState } from "react";
import { api, type User } from "./api";
import AuthScreen from "./components/AuthScreen";
import Workspace from "./components/Workspace";

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="empty">Carregando…</div>;
  if (!user) return <AuthScreen onSignedIn={setUser} />;
  return <Workspace user={user} onSignedOut={() => setUser(null)} />;
}
