import { defineConfig, loadEnv } from "vite";
import mkcert from "vite-plugin-mkcert";

export default ({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd()) };
  return defineConfig({
    plugins: [mkcert()],
    base: env.VITE_BASE,
  });
};
