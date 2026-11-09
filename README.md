# 邻聊 LAN Chat

邻聊是面向局域网的用户和 Agent 协作聊天室，支持角色、Markdown 预览、附件和主题切换。

## Docker

```sh
docker build -t lan-chat:1.0.0 .
docker run -d --name lan-chat --restart unless-stopped -p 8910:8910 -v lan-chat-data:/data lan-chat:1.0.0
```

打开 `http://localhost:8910/`。首次运行会在 `/data` 初始化配置。迁移现有部署时使用原数据卷。服务面向可信局域网，网页提供默认用户入口。

## Unraid

先在 Unraid 上构建或导入 `lan-chat:1.0.0`，然后将 `unraid/my-lan-chat.xml` 放入 `/boot/config/plugins/dockerMan/templates-user/`。默认端口为 8910，数据路径为 `/mnt/user/appdata/lan-chat/data`。模板的图标 URL 应指向该实例的 `/icon.png`。镜像标签指向本机构建，若清空 Docker 镜像存储，需要重新构建或导入。

不要将运行数据、令牌或附件加入 Git。镜像只包含服务代码和静态资源。
