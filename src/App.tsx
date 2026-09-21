import { Navigate, Route, Routes } from "react-router";
import Layout from "./components/Layout";
import Editor from "./routes/Editor";
import Library from "./routes/Library";
import Machine from "./routes/Machine";
import Secrets from "./routes/Secrets";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Machine />} />
        <Route path="library" element={<Library />} />
        <Route path="new" element={<Editor />} />
        <Route path="edit/:id" element={<Editor />} />
        <Route path="secrets" element={<Secrets />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
