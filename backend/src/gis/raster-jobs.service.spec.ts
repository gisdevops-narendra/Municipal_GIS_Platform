import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RasterJobsService } from './raster-jobs.service';
import { rasterJobContext } from './raster-job-context';

const user = { id: 'u1', municipalityId: 'm1' } as never;
const other = { id: 'u2', municipalityId: 'm1' } as never;
const body = { layerId: '0b8f2a8e-4a51-4c1e-9f0f-0d5f3c3f6b21', outputName: 'Filled' };
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('RasterJobsService', () => {
  let release: (value: unknown) => void;
  let fillSinks: jest.Mock;
  let service: RasterJobsService;

  beforeEach(() => {
    fillSinks = jest.fn(
      () =>
        new Promise((resolve, reject) => {
          release = resolve;
          rasterJobContext.getStore()?.signal.addEventListener('abort', () => reject(new Error('killed')));
        }),
    );
    service = new RasterJobsService({ fillSinks } as never, {
      rasterJobHistory: {
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
    } as never);
  });

  it('validates the body against the tool DTO', async () => {
    await expect(service.start(user, 'fill-sinks', { layerId: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.start(user, 'fill-sinks', { ...body, extra: 1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.start(user, 'nope', body)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('runs a job and reports its result', async () => {
    const job = await service.start(user, 'fill-sinks', body);
    expect(job.status).toBe('running');
    release({ layer: { id: 'l1' } });
    await flush();
    expect(service.get(user, job.id)).toMatchObject({ status: 'done', result: { layer: { id: 'l1' } } });
  });

  it('hides jobs from other users', async () => {
    const job = await service.start(user, 'fill-sinks', body);
    expect(() => service.get(other, job.id)).toThrow(NotFoundException);
  });

  it('cancels a running job by aborting it', async () => {
    const job = await service.start(user, 'fill-sinks', body);
    service.cancel(user, job.id);
    await flush();
    expect(service.get(user, job.id).status).toBe('cancelled');
  });

  it('queues beyond the concurrency limit and caps jobs per user', async () => {
    const jobs: Awaited<ReturnType<RasterJobsService['start']>>[] = [];
    for (let i = 0; i < 4; i++) jobs.push(await service.start(user, 'fill-sinks', body));
    expect(jobs.map((j) => j.status)).toEqual(['running', 'running', 'running', 'queued']);
    await expect(service.start(user, 'fill-sinks', body)).rejects.toBeInstanceOf(ConflictException);
    expect(service.cancel(user, jobs[3].id).status).toBe('cancelled');
  });

  it('refuses to cancel once the result is being published', async () => {
    fillSinks.mockImplementation(() => {
      rasterJobContext.getStore()?.setStage('Publishing', false);
      return new Promise(() => undefined);
    });
    const job = await service.start(user, 'fill-sinks', body);
    expect(() => service.cancel(user, job.id)).toThrow(ConflictException);
  });
});
