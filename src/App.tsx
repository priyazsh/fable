import { WorkspaceProvider } from "@/state/WorkspaceContext";
import { Shell } from "@/shell/Shell";

export default function App() {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  );
}
