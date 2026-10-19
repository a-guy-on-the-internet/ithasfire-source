output "id" {
  description = "Queue path, projects/<project>/locations/<location>/queues/<name> (the form the Cloud Tasks REST API and CLOUD_TASKS_QUEUE take)."
  value       = google_cloud_tasks_queue.this.id
}

output "name" {
  description = "Queue name."
  value       = google_cloud_tasks_queue.this.name
}
