import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
// Named import, not default: under NodeNext module resolution ajv's default
// export has no construct signature.
import { Ajv } from 'ajv';
import { CONFIG_DIR } from './core/config.js';

// ==========================================
// 1. TYPES & INTERFACES
// ==========================================
export type AgentRole = 'orchestrator' | 'analyzer' | 'writer' | 'documenter';

export interface AgentTask {
  id: string;
  role: AgentRole;
  model: string;
  executionTime: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: any;
  error?: string;
}

export interface ScratchpadState {
  objective: string;
  activeFiles: string[];
  tasks: AgentTask[];
  artifacts: Record<string, any>;
  createdAt: number;
  lastUpdated: string;
}

export interface AgentResult {
  role: string;
  output: string;
  metadata: {
    timestamp: number;
    executionTime: number;
    model: string;
  };
}

export interface AgentContext {
  objective: string;
  artifacts: Record<string, unknown>;
  previousResults: AgentResult[];
}

// ==========================================
// 2. JSON SCHEMAS FOR VALIDATION
// ==========================================
export const AnalyzerOutputSchema = {
  type: 'object',
  properties: {
    dependencies: {
      type: 'array',
      items: { type: 'string' },
    },
    files_to_modify: {
      type: 'array',
      items: { type: 'string' },
    },
    reasoning: { type: 'string' },
    priority: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
  },
  required: ['dependencies', 'files_to_modify', 'reasoning', 'priority'],
};

export const WriterOutputSchema = {
  type: 'object',
  properties: {
    code_changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          action: {
            type: 'string',
            enum: ['create', 'modify', 'delete'],
          },
          content: { type: 'string' },
        },
        required: ['file', 'action', 'content'],
      },
    },
    explanation: { type: 'string' },
    validation_steps: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['code_changes', 'explanation', 'validation_steps'],
};

export const DocumenterOutputSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    changes_made: {
      type: 'array',
      items: { type: 'string' },
    },
    next_steps: {
      type: 'array',
      items: { type: 'string' },
    },
    formatting_notes: { type: 'string' },
  },
  required: ['summary', 'changes_made', 'next_steps', 'formatting_notes'],
};

// ==========================================
// 3. SCHEMA VALIDATOR
// ==========================================
export class SchemaValidator {
  private ajv = new Ajv();

  public validate(data: unknown, schema: any): { valid: boolean; errors?: any[] } {
    const valid = this.ajv.validate(schema, data);
    return {
      valid,
      errors: this.ajv.errors || undefined,
    };
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ==========================================
// 4. TRANSFORMATION & VALIDATION LAYER
// ==========================================
export class TransformationPipeline {
  private validator = new SchemaValidator();

  public async validateAgentOutput(role: string, output: string, schema: any): Promise<any> {
    let parsed: any;

    // Try to parse as JSON
    try {
      parsed = JSON.parse(output);
    } catch (e) {
      // If not JSON, try to extract JSON from markdown code blocks
      const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[1]);
        } catch (innerE) {
          throw new ValidationError(
            `${role}: Could not extract valid JSON from output. Raw: ${output.substring(0, 200)}...`
          );
        }
      } else {
        throw new ValidationError(
          `${role}: Output is not valid JSON and contains no code blocks. Got: ${output.substring(0, 200)}...`
        );
      }
    }

    // Validate against schema
    const validation = this.validator.validate(parsed, schema);

    if (!validation.valid) {
      throw new ValidationError(
        `${role}: Output does not match expected schema. Errors: ${JSON.stringify(validation.errors)}`
      );
    }

    return parsed;
  }

  public async transformAnalyzerOutput(
    raw: string,
    context: AgentContext
  ): Promise<{
    dependencies: string[];
    files_to_modify: string[];
    reasoning: string;
    priority: string;
  }> {
    return this.validateAgentOutput('analyzer', raw, AnalyzerOutputSchema);
  }

  public async transformWriterOutput(
    raw: string,
    context: AgentContext
  ): Promise<{
    code_changes: Array<{ file: string; action: string; content: string }>;
    explanation: string;
    validation_steps: string[];
  }> {
    return this.validateAgentOutput('writer', raw, WriterOutputSchema);
  }

  public async transformDocumenterOutput(
    raw: string,
    context: AgentContext
  ): Promise<{
    summary: string;
    changes_made: string[];
    next_steps: string[];
    formatting_notes: string;
  }> {
    return this.validateAgentOutput('documenter', raw, DocumenterOutputSchema);
  }
}

// ==========================================
// 5. SCRATCHPAD MANAGER (Shared State Ledger)
// ==========================================
export class ScratchpadManager {
  private statePath: string;
  private state: ScratchpadState;

  // Defaulting to './scratchpad.json' wrote state into whatever directory
  // `cullus` happened to be launched from, leaving stray files around the
  // filesystem. Runtime state belongs in ~/.cullus with everything else.
  constructor(statePath: string = path.join(CONFIG_DIR, 'orchestrator-state.json')) {
    this.statePath = statePath;
    this.state = {
      objective: '',
      activeFiles: [],
      tasks: [],
      artifacts: {},
      createdAt: Date.now(),
      lastUpdated: new Date().toISOString(),
    };
  }

  public async initialize(objective: string): Promise<void> {
    this.state = {
      objective,
      activeFiles: [],
      tasks: [],
      artifacts: {},
      createdAt: Date.now(),
      lastUpdated: new Date().toISOString(),
    };
    await this.persist();
  }

  public async updateState(updater: (s: ScratchpadState) => void): Promise<ScratchpadState> {
    updater(this.state);
    this.state.lastUpdated = new Date().toISOString();
    await this.persist();
    return this.state;
  }

  public getState(): ScratchpadState {
    return { ...this.state };
  }

  private async persist(): Promise<void> {
    try {
      await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to persist scratchpad state:', err);
    }
  }
}

// ==========================================
// 6. BASE WORKER AGENT (STATELESS)
// ==========================================
export abstract class BaseAgent {
  protected role: string;
  protected model: string;
  protected ollamaUrl: string;

  constructor(role: string, model: string, ollamaUrl: string = 'http://localhost:11434') {
    this.role = role;
    this.model = model;
    this.ollamaUrl = ollamaUrl;
  }

  public abstract buildSystemPrompt(context: AgentContext): string;

  public async execute(userPrompt: string, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now();
    const system = this.buildSystemPrompt(context);

    try {
      const output = await this.callOllama(system, userPrompt);
      return {
        role: this.role,
        output,
        metadata: {
          timestamp: Date.now(),
          executionTime: Date.now() - startTime,
          model: this.model,
        },
      };
    } catch (error: any) {
      throw new AgentExecutionError(this.role, error);
    }
  }

  protected async callOllama(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: `${systemPrompt}\n\nUser Request: ${userPrompt}`,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error for role ${this.role}: ${response.statusText}`);
    }

    const data = await response.json();
    return data.response;
  }
}

export class AgentExecutionError extends Error {
  constructor(role: string, originalError: any) {
    super(`Agent '${role}' failed: ${originalError.message}`);
    this.name = 'AgentExecutionError';
  }
}

// ==========================================
// 7. SPECIALIZED AGENTS
// ==========================================
export class CodeAnalyzerAgent extends BaseAgent {
  constructor(model: string) {
    super('analyzer', model);
  }

  public buildSystemPrompt(context: AgentContext): string {
    return `You are a Code Analyzer Agent. Inspect the project context and outline specific structural dependencies or files that require modification.

Current objective: ${context.objective}

IMPORTANT: Return your analysis as a JSON object with this exact structure:
{
  "dependencies": ["dep1", "dep2"],
  "files_to_modify": ["file1.ts", "file2.ts"],
  "reasoning": "Your detailed analysis here",
  "priority": "high" | "medium" | "low"
}`;
  }
}

export class CodeWriterAgent extends BaseAgent {
  constructor(model: string) {
    super('writer', model);
  }

  public buildSystemPrompt(context: AgentContext): string {
    return `You are a Systems Engineer Agent. Generate clean, production-grade code adjustments following architectural constraints.

Current objective: ${context.objective}

Previous analysis:
${context.previousResults.find((r) => r.role === 'analyzer')?.output || 'None'}

IMPORTANT: Return your implementation as a JSON object with this exact structure:
{
  "code_changes": [
    {
      "file": "path/to/file.ts",
      "action": "create" | "modify" | "delete",
      "content": "full file content or patch"
    }
  ],
  "explanation": "Why these changes were made",
  "validation_steps": ["step1", "step2"]
}`;
  }
}

export class DocumenterAgent extends BaseAgent {
  constructor(model: string) {
    super('documenter', model);
  }

  public buildSystemPrompt(context: AgentContext): string {
    return `You are an Engineering Manager & Documenter Agent. Review the executed artifact and provide a concise final summary.

Current objective: ${context.objective}

Implementation completed:
${context.previousResults.find((r) => r.role === 'writer')?.output || 'None'}

IMPORTANT: Return your documentation as a JSON object with this exact structure:
{
  "summary": "Brief overview of what was done",
  "changes_made": ["change1", "change2"],
  "next_steps": ["step1", "step2"],
  "formatting_notes": "Any formatting or compliance issues found"
}`;
  }
}

// ==========================================
// 8. HIERARCHICAL ORCHESTRATOR ENGINE
// ==========================================
export class OrchestratorEngine extends EventEmitter {
  private scratchpad: ScratchpadManager;
  private analyzer: CodeAnalyzerAgent;
  private writer: CodeWriterAgent;
  private documenter: DocumenterAgent;
  private transformationPipeline: TransformationPipeline;

  constructor(models: { analyzer: string; writer: string; documenter: string }, statePath?: string) {
    super();
    this.scratchpad = new ScratchpadManager(statePath);
    this.analyzer = new CodeAnalyzerAgent(models.analyzer);
    this.writer = new CodeWriterAgent(models.writer);
    this.documenter = new DocumenterAgent(models.documenter);
    this.transformationPipeline = new TransformationPipeline();
  }

  public async runWorkflow(userPrompt: string): Promise<void> {
    await this.scratchpad.initialize(userPrompt);
    this.emit('status', 'Orchestrator: Initializing scratchpad state...');

    const context: AgentContext = {
      objective: this.scratchpad.getState().objective,
      artifacts: this.scratchpad.getState().artifacts,
      previousResults: [],
    };

    try {
      // ===== STEP 1: ANALYZER =====
      this.emit('step-started', { role: 'analyzer' });
      const startAnalyzer = Date.now();

      const analyzerResult = await this.analyzer.execute(userPrompt, context);
      this.emit('step-progress', {
        role: 'analyzer',
        message: 'Validating analyzer output...',
      });

      let analyzerData: any;
      try {
        analyzerData = await this.transformationPipeline.transformAnalyzerOutput(
          analyzerResult.output,
          context
        );
      } catch (validationError: any) {
        this.emit('step-error', {
          role: 'analyzer',
          error: validationError.message,
        });
        throw validationError;
      }

      context.previousResults.push(analyzerResult);
      await this.scratchpad.updateState((s) => {
        s.tasks.push({
          id: `task-${Date.now()}`,
          role: 'analyzer',
          model: analyzerResult.metadata.model,
          executionTime: analyzerResult.metadata.executionTime,
          status: 'completed',
          result: analyzerData,
        });
        s.artifacts['analysis'] = analyzerData;
      });

      this.emit('step-complete', {
        role: 'analyzer',
        output: analyzerData,
        duration: Date.now() - startAnalyzer,
      });

      // ===== STEP 2: WRITER =====
      this.emit('step-started', { role: 'writer' });
      const startWriter = Date.now();

      context.artifacts = this.scratchpad.getState().artifacts;
      const writerResult = await this.writer.execute(
        JSON.stringify(analyzerData),
        context
      );

      this.emit('step-progress', {
        role: 'writer',
        message: 'Validating implementation output...',
      });

      let writerData: any;
      try {
        writerData = await this.transformationPipeline.transformWriterOutput(
          writerResult.output,
          context
        );
      } catch (validationError: any) {
        this.emit('step-error', {
          role: 'writer',
          error: validationError.message,
        });
        throw validationError;
      }

      context.previousResults.push(writerResult);
      await this.scratchpad.updateState((s) => {
        s.tasks.push({
          id: `task-${Date.now()}`,
          role: 'writer',
          model: writerResult.metadata.model,
          executionTime: writerResult.metadata.executionTime,
          status: 'completed',
          result: writerData,
        });
        s.artifacts['implementation'] = writerData;
      });

      this.emit('step-complete', {
        role: 'writer',
        output: writerData,
        duration: Date.now() - startWriter,
      });

      // ===== STEP 3: DOCUMENTER =====
      this.emit('step-started', { role: 'documenter' });
      const startDocumenter = Date.now();

      context.artifacts = this.scratchpad.getState().artifacts;
      const documenterResult = await this.documenter.execute(
        JSON.stringify(writerData),
        context
      );

      this.emit('step-progress', {
        role: 'documenter',
        message: 'Validating documentation output...',
      });

            let documenterData: any;
      try {
        documenterData = await this.transformationPipeline.transformDocumenterOutput(
          documenterResult.output,
          context
        );
      } catch (validationError: any) {
        this.emit('step-error', {
          role: 'documenter',
          error: validationError.message,
        });
        throw validationError;
      }

      context.previousResults.push(documenterResult);
      await this.scratchpad.updateState((s) => {
        s.tasks.push({
          id: `task-${Date.now()}`,
          role: 'documenter',
          model: documenterResult.metadata.model,
          executionTime: documenterResult.metadata.executionTime,
          status: 'completed',
          result: documenterData,
        });
        s.artifacts['documentation'] = documenterData;
      });

      this.emit('step-complete', {
        role: 'documenter',
        output: documenterData,
        duration: Date.now() - startDocumenter,
      });

      this.emit('workflow-complete', {
        artifacts: this.scratchpad.getState().artifacts,
        totalDuration: Date.now() - this.scratchpad.getState().createdAt,
      });
    } catch (err: any) {
      this.emit('workflow-error', {
        error: err.message,
        role: err.role || 'unknown',
      });
      throw err;
    }
  }

  public getState(): ScratchpadState {
    return this.scratchpad.getState();
  }
}
