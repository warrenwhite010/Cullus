// websocket/PipelineQueueManager.ts
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

export interface QueuedRequest {
  id: string;
  prompt: string;
  models: { analyzer: string; writer: string; documenter: string };
  createdAt: number;
  priority: number;
}

export interface QueueStatus {
  queued: number;
  processing: boolean;
  completed: number;
  totalEnqueued: number;
}

export class PipelineQueueManager extends EventEmitter {
  private queue: QueuedRequest[] = [];
  private processing: boolean = false;
  private currentRequestId: string | null = null;
  private readonly maxQueueSize: number;
  private completedCount: number = 0;
  private totalEnqueued: number = 0;

  constructor(maxQueueSize: number = 10) {
    super();
    this.maxQueueSize = maxQueueSize;
  }

  public enqueue(request: Omit<QueuedRequest, 'id' | 'createdAt'>): boolean {
    // Reject if queue is full
    if (this.queue.length >= this.maxQueueSize) {
      this.emit('queue-full', { currentSize: this.queue.length, maxSize: this.maxQueueSize });
      return false;
    }

    const queuedRequest: QueuedRequest = {
      id: uuidv4(),
      prompt: request.prompt,
      models: request.models,
      createdAt: Date.now(),
      priority: request.priority,
    };

    // Insert by priority (higher priority first)
    const insertIndex = this.queue.findIndex((r) => r.priority < queuedRequest.priority);
    if (insertIndex === -1) {
      this.queue.push(queuedRequest);
    } else {
      this.queue.splice(insertIndex, 0, queuedRequest);
    }

    this.totalEnqueued++;
    this.emit('queue-updated', this.getQueueStatus());
    return true;
  }

  public dequeue(): QueuedRequest | null {
    if (this.queue.length === 0) return null;
    const request = this.queue.shift();
    if (request) {
      this.currentRequestId = request.id;
    }
    this.emit('queue-updated', this.getQueueStatus());
    return request || null;
  }

  public cancel(requestId: string): boolean {
    // Cannot cancel if currently processing
    if (this.currentRequestId === requestId && this.processing) {
      return false;
    }

    const index = this.queue.findIndex((r) => r.id === requestId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      this.emit('request-dropped', requestId);
      this.emit('queue-updated', this.getQueueStatus());
      return true;
    }

    return false;
  }

  public markProcessingStarted(): void {
    this.processing = true;
    this.emit('queue-updated', this.getQueueStatus());
  }

  public markProcessingComplete(): void {
    this.processing = false;
    this.completedCount++;
    this.currentRequestId = null;
    this.emit('queue-updated', this.getQueueStatus());
  }

  public isProcessing(): boolean {
    return this.processing;
  }

  public getQueueStatus(): QueueStatus {
    return {
      queued: this.queue.length,
      processing: this.processing,
      completed: this.completedCount,
      totalEnqueued: this.totalEnqueued,
    };
  }

  public getPendingRequests(): QueuedRequest[] {
    return [...this.queue];
  }

  public clear(): void {
    if (this.processing) {
      console.warn('Cannot clear queue while processing');
      return;
    }
    this.queue = [];
    this.emit('queue-updated', this.getQueueStatus());
  }
}
