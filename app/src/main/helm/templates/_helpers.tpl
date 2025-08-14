{{/*
Expand the name of the chart.
*/}}
{{- define "mcp-client.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "mcp-client.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "mcp-client.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "mcp-client.labels" -}}
helm.sh/chart: {{ include "mcp-client.chart" . }}
{{ include "mcp-client.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "mcp-client.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mcp-client.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ include "mcp-client.fullname" . }}
app.kubernetes.io/part-of: Ideascale
{{- end }}

{{/*
Create ConfigMap name for deployment
*/}}
{{- define "mcp-client.configmap" -}}
{{- printf "%s-%s"  (include "mcp-client.fullname" .) "properties" }}
{{- end }}
{{/*
ingress annotations
*/}}
{{ define "mcp-client.ingress-annotations" -}}
nginx.ingress.kubernetes.io/use-regex: "true"
nginx.ingress.kubernetes.io/server-snippet: |
  underscores_in_headers on;
{{- range $key, $val := .Values.ingress.extraAnnotations }}
{{ $key }}: {{ $val | quote }}
{{- end }}
{{- end }}
