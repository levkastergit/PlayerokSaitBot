FROM nginx:1.25-alpine

# Бэкенд слушает на хосте (app с network_mode: host), не в docker-сети.
COPY nginx/conf.d/ /etc/nginx/conf.d/
