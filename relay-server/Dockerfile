FROM golang:1.27-alpine AS build

RUN apk add --no-cache build-base
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /out/relay-server ./cmd/relay-server

FROM alpine:3.23

RUN apk add --no-cache ca-certificates
COPY --from=build /out/relay-server /relay-server
USER 65532:65532
EXPOSE 4821
ENTRYPOINT ["/relay-server"]
