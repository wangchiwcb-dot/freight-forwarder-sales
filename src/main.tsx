import React from "react";
import ReactDOM from "react-dom/client";
import "@ant-design/v5-patch-for-react-19";
import { ConfigProvider, App as AntApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Application } from "./App";
import "./styles/app.css";
const queryClient = new QueryClient();
const router = createBrowserRouter([{ path: "*", element: <Application /> }]);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          token: {
            colorPrimary: "#185492",
            colorText: "#1F2733",
            colorTextSecondary: "#5A6675",
            colorBgLayout: "#F5F7FA",
            colorBorder: "#E3E8EF",
            borderRadius: 8,
            fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif',
            fontSize: 14,
            controlHeight: 38,
          },
          components: {
            Drawer: { paddingLG: 24 },
            Table: { headerBg: "#F7F9FC", headerColor: "#5A6675" },
            Modal: { borderRadiusLG: 12 },
          },
        }}
      >
        <AntApp>
          <RouterProvider router={router} />
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
